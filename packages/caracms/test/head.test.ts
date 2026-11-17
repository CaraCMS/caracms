// M6 Decisions 3, 12, 15 and 16 (Acceptance 29–31, 34): the head's rules, SITE_URL as Astro's site, the sitemap's injection.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { resolveSite, type SiteConfig } from '../src/config.ts';
import type { PageDocument } from '../src/document.ts';
import { googleTagSnippet, headOf, type HeadInput } from '../src/head.ts';
import { MEMORY_MEDIA, type MediaConfig } from '../src/media.ts';
import { siteAddress, SITEMAP_ROUTE, trustedDomains, virtualModules } from '../src/index.ts';
import { site } from './helpers/site.ts';

const media: MediaConfig = { kind: 'ready', settings: { ...MEMORY_MEDIA, memory: false } };
const settings = (extra: Record<string, unknown> = {}) => JSON.stringify({ title: 'Site Settings', brand: { name: 'CaraCMS' }, ...extra });
const page = (title: string, seo?: Record<string, unknown>): PageDocument => ({ title, blocks: [], ...(seo ? { seo } : {}) }) as PageDocument;
const input = (patch: Partial<HeadInput>): HeadInput => ({ document: page('About'), settingsText: settings(), path: '/about', siteUrl: 'https://site.test', media, tagAllowed: true, ...patch });

describe('the title (Acceptance 29)', () => {
	test('no seo: <document title> · <brand name>', () => assert.equal(headOf(input({})).title, 'About · CaraCMS'));
	test("a page's seo.title is used as written", () => assert.equal(headOf(input({ document: page('About', { title: 'About the studio' }) })).title, 'About the studio'));
	test("the home page: Site Settings' seo.title, then the brand name", () => {
		assert.equal(headOf(input({ path: '/', document: page('Home'), settingsText: settings({ seo: { title: 'CaraCMS, a design studio' } }) })).title, 'CaraCMS, a design studio');
		assert.equal(headOf(input({ path: '/', document: page('Home') })).title, 'CaraCMS');
		assert.equal(headOf(input({ path: '/', document: page('Home', { title: 'Own' }) })).title, 'Own');
	});
	test('no brand name: the title alone; no Site Settings file: the same', () => {
		assert.equal(headOf(input({ settingsText: JSON.stringify({ title: 'Site Settings' }) })).title, 'About');
		assert.equal(headOf(input({ settingsText: null })).title, 'About');
		assert.equal(headOf(input({ settingsText: '{ broken' })).title, 'About');
	});
	test("the config's titleSeparator joins them (M8 trial round 2); left out, ' · '", () => {
		assert.equal(headOf(input({ titleSeparator: ' | ' })).title, 'About | CaraCMS');
		assert.equal(headOf(input({ titleSeparator: ' · ' })).title, 'About · CaraCMS');
		assert.equal(headOf(input({ titleSeparator: undefined })).title, 'About · CaraCMS');
		assert.equal(headOf(input({ titleSeparator: ' | ', listPage: 2, document: page('Journal') })).title, 'Journal — page 2 | CaraCMS');
		assert.equal(headOf(input({ titleSeparator: ' | ', path: '/', document: page('Home') })).title, 'CaraCMS', 'the home page has no separator');
		assert.equal(headOf(input({ titleSeparator: ' | ', settingsText: null })).title, 'About', 'no brand name: no separator');
	});
	test("titleFallback 'site' (M9): every page falls back as the home page does", () => {
		const titled = settings({ seo: { title: 'CaraCMS, a design studio' } });
		assert.equal(headOf(input({ titleFallback: 'site', settingsText: titled })).title, 'CaraCMS, a design studio', "Site Settings' seo.title");
		assert.equal(headOf(input({ titleFallback: 'site', settingsText: titled, titleSeparator: ' | ' })).title, 'CaraCMS, a design studio', 'no separator');
		assert.equal(headOf(input({ titleFallback: 'site' })).title, 'CaraCMS', 'then the brand name');
		assert.equal(headOf(input({ titleFallback: 'site', settingsText: null })).title, 'About', 'then the document title');
		assert.equal(headOf(input({ titleFallback: 'site', settingsText: titled, document: page('About', { title: 'Own' }) })).title, 'Own', "the page's own seo.title first");
		assert.equal(headOf(input({ titleFallback: 'site', settingsText: titled, listPage: 2, document: page('Journal') })).title, 'CaraCMS, a design studio — page 2', 'the paged-listing rule');
		assert.equal(headOf(input({ titleFallback: 'site', settingsText: titled, path: null })).title, 'CaraCMS, a design studio', 'a preview without a path');
		assert.equal(headOf(input({ titleFallback: 'page-and-brand' })).title, 'About · CaraCMS', "'page-and-brand': today's");
	});
	test("resolveSite: titleFallback defaults to 'page-and-brand', keeps 'site', and refuses anything else", () => {
		const root = mkdtempSync(join(tmpdir(), 'caracms-title-fallback-'));
		writeFileSync(join(root, 'Page.astro'), '---\n---\n');
		const config = (extra: Partial<SiteConfig>) => ({ collections: { pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true } }, blocks: { text: { component: 'Page.astro', fields: {} } }, textStyles: {}, page: 'Page.astro', ...extra }) as SiteConfig;
		try {
			assert.equal(resolveSite(config({}), root).titleFallback, 'page-and-brand');
			assert.equal(resolveSite(config({ titleFallback: 'site' }), root).titleFallback, 'site');
			assert.throws(() => resolveSite(config({ titleFallback: 'brand' as 'site' }), root), /titleFallback must be/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test('resolveSite: titleSeparator defaults to " · ", keeps one set, and refuses an empty one', () => {
		const root = mkdtempSync(join(tmpdir(), 'caracms-title-separator-'));
		writeFileSync(join(root, 'Page.astro'), '---\n---\n');
		const config = (extra: Partial<SiteConfig>) => ({ collections: { pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true } }, blocks: { text: { component: 'Page.astro', fields: {} } }, textStyles: {}, page: 'Page.astro', ...extra }) as SiteConfig;
		try {
			assert.equal(resolveSite(config({}), root).titleSeparator, ' · ');
			assert.equal(resolveSite(config({ titleSeparator: ' | ' }), root).titleSeparator, ' | ');
			assert.throws(() => resolveSite(config({ titleSeparator: '' }), root), /titleSeparator must be/);
			assert.throws(() => resolveSite(config({ titleSeparator: ' \n ' }), root), /titleSeparator must be/);
			assert.throws(() => resolveSite(config({ titleSeparator: 3 as unknown as string }), root), /titleSeparator must be/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('the canonical link, the description and the share image (Acceptance 30–31)', () => {
	test('canonical and og:url on SITE_URL; without it, neither; never in a preview', () => {
		assert.equal(headOf(input({ path: '/about/' })).canonical, 'https://site.test/about');
		assert.equal(headOf(input({ path: '/' })).canonical, 'https://site.test/');
		assert.equal(headOf(input({ siteUrl: null })).canonical, null);
		assert.equal(headOf(input({ path: null })).canonical, null);
	});

	test("the description falls back to Site Settings'; with neither, none", () => {
		assert.equal(headOf(input({ settingsText: settings({ seo: { description: 'Default' } }) })).description, 'Default');
		assert.equal(headOf(input({ document: page('About', { description: 'Own' }), settingsText: settings({ seo: { description: 'Default' } }) })).description, 'Own');
		assert.equal(headOf(input({})).description, null);
	});

	test("the share image: a signed 1200 × 630 rs:fill with the focal point's gravity; Site Settings' default; none with neither", () => {
		const own = headOf(input({ document: page('About', { image: { key: 'uploads/3f9a1c07b2e4/harbour-wall.jpg', w: 4000, h: 2667, focal: [0.4, 0.3] } }) }));
		assert.match(own.image!.url, /^https:\/\/img\.test\/[\w-]+\/rs:fill:1200:630\/g:fp:0\.4:0\.3\/q:80\/plain\/s3:\/\/caracms-test-media\/uploads\/3f9a1c07b2e4\/harbour-wall\.jpg@webp$/);
		assert.equal(own.image!.width, 1200);
		assert.equal(own.twitterCard, 'summary_large_image');
		const fallback = headOf(input({ settingsText: settings({ seo: { image: { key: 'uploads/77ab03fe5c90/kiln.jpg' } } }) }));
		assert.match(fallback.image!.url, /rs:fill:1200:630\/q:80\/plain\/.+kiln\.jpg@webp$/, 'no focal point: no gravity');
		assert.equal(headOf(input({})).image, null);
		assert.equal(headOf(input({})).twitterCard, 'summary');
		assert.equal(headOf(input({ document: page('A', { image: { key: 'uploads/77ab03fe5c90/kiln.jpg' } }), media: { kind: 'unset', missing: ['S3_BUCKET'], problems: [] } })).image, null, 'no media: no og:image');
	});
});

describe('the Google tag (Acceptance 34)', () => {
	test('GTM- and G- IDs render their snippets; anything else nothing', () => {
		const gtm = headOf(input({ settingsText: settings({ googleTag: 'GTM-ABC1234' }) })).googleTag!;
		assert.deepEqual(gtm, { kind: 'gtm', id: 'GTM-ABC1234' });
		assert.match(googleTagSnippet(gtm), /googletagmanager\.com\/gtm\.js\?id='\+i;.*'dataLayer',"GTM-ABC1234"\);<\/script>$/);
		const gtag = headOf(input({ settingsText: settings({ googleTag: 'G-ABCDE12345' }) })).googleTag!;
		assert.match(googleTagSnippet(gtag), /^<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-ABCDE12345"><\/script><script>.*gtag\('config',"G-ABCDE12345"\);<\/script>$/);
		for (const bad of ['<script>alert(1)</script>', 'G-', 'UA-123']) assert.equal(headOf(input({ settingsText: settings({ googleTag: bad }) })).googleTag, null, bad);
	});
	test('none in a preview or a dev build (tagAllowed is false there)', () => {
		assert.equal(headOf(input({ settingsText: settings({ googleTag: 'G-ABCDE12345' }), tagAllowed: false })).googleTag, null);
	});
});

describe('SITE_URL (Decision 3) and the sitemap (Decision 12)', () => {
	test("SITE_URL is the site's address unless the config sets one; no trailing slash; a bad one is refused", () => {
		assert.deepEqual(siteAddress(undefined, { SITE_URL: 'https://site.test/' }), { url: 'https://site.test', problem: null });
		assert.deepEqual(siteAddress('https://own.test', { SITE_URL: 'https://site.test' }), { url: 'https://own.test', problem: null });
		assert.deepEqual(siteAddress(undefined, {}), { url: null, problem: null });
		assert.match(siteAddress(undefined, { SITE_URL: 'site.test' }).problem!, /SITE_URL must be the site's address/);
		assert.match(siteAddress(undefined, { SITE_URL: 'ftp://site.test' }).problem!, /must start with https/);
	});
	test("Astro's allowed domains take SITE_URL's host", () => {
		assert.deepEqual(trustedDomains('https://site.test', undefined, {}), [{ hostname: 'site.test', protocol: 'https' }]);
	});
	test('the public module carries the address, the Turnstile site key and the build kind', () => {
		const modules = virtualModules(site, { siteUrl: 'https://site.test', turnstileSiteKey: '1x00000000000000000000AA', production: true });
		assert.equal(modules['virtual:caracms/public'], 'export const build = {"siteUrl":"https://site.test","turnstileSiteKey":"1x00000000000000000000AA","production":true};\n');
		assert.equal(SITEMAP_ROUTE.pattern, '/sitemap.xml');
	});
});
