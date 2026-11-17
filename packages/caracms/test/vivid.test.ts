// Vivid (the config's `vivid`, src/vivid.ts): the switch's config check, the editor address and origin
// `data-vivid-edit` is built from, the 200-character cap on `data-vivid-field`, and the document tag
// `readDocument` leaves. The rendered attributes are checked on the starter (starter/test/vivid.test.ts).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CaracmsConfigError, resolveSite, type SiteConfig } from '../src/config.ts';
import { readDocument } from '../src/content.ts';
import { documentRefOf, vividEditPath, vividMarkers, vividOrigin, vividShared, VIVID_SETTINGS } from '../src/vivid.ts';
import { site, siteRoot, variant } from './helpers/site.ts';

describe('the config\'s vivid', () => {
	test('false by default; true or false only', () => {
		assert.equal(site.vivid, false);
		assert.equal(resolveSite(variant({ vivid: true }), siteRoot).vivid, true);
		assert.throws(() => resolveSite(variant({ vivid: 'yes' } as unknown as Partial<SiteConfig>), siteRoot), (e: Error) => e instanceof CaracmsConfigError && /vivid must be true/.test(e.message));
	});
});

describe('data-vivid-edit', () => {
	const collections = {
		pages: { name: 'pages', nested: true },
		'case-studies': { name: 'case-studies', nested: false },
	} as never;

	test('the editor\'s address: Home at /admin, Site Settings, a shared block, a nested page', () => {
		assert.equal(vividEditPath({ collections }, { collection: 'pages', path: 'index' }), '/admin');
		assert.equal(vividEditPath({ collections }, { collection: 'pages', path: 'services/branding' }), '/admin/pages/services/branding');
		assert.equal(vividEditPath({ collections }, VIVID_SETTINGS), '/admin/settings');
		assert.equal(vividEditPath({ collections }, vividShared('footer')), '/admin/shared/footer');
		assert.equal(vividEditPath({ collections }, { collection: 'case-studies', path: 'a b' }), '/admin/case-studies/a%20b');
	});

	test('the origin: the dev server\'s in dev, else Astro\'s site, SITE_URL, then Railway\'s domain', () => {
		const request = new URL('http://localhost:4326/about');
		assert.equal(vividOrigin(true, request, new URL('https://example.com'), {}), 'http://localhost:4326');
		assert.equal(vividOrigin(false, request, new URL('https://example.com/sub/'), { SITE_URL: 'https://other.test' }), 'https://example.com');
		assert.equal(vividOrigin(false, request, undefined, { SITE_URL: 'https://example.com' }), 'https://example.com');
		assert.equal(vividOrigin(false, request, undefined, { RAILWAY_PUBLIC_DOMAIN: 'site.up.railway.app' }), 'https://site.up.railway.app');
		assert.equal(vividOrigin(false, request, undefined, {}), null, 'never the request\'s host in a build');
	});
});

describe('the attributes', () => {
	const collections = { pages: { name: 'pages', nested: true } } as never;

	test('none without a document on the context (off, or a preview)', () => {
		assert.deepEqual(vividMarkers({ collections }, {}, 'heading', 'https://example.com'), {});
		assert.deepEqual(vividMarkers({ collections }, { vivid: null }, 'heading', 'https://example.com'), {});
	});

	test('the field at its path in the file, and the editor address', () => {
		const cms = { vivid: { collection: 'pages', path: 'about', prefix: 'blocks.2.' } };
		assert.deepEqual(vividMarkers({ collections }, cms, 'credits.1.name', 'https://example.com'), {
			'data-vivid-field': 'pages/about#blocks.2.credits.1.name',
			'data-vivid-edit': 'https://example.com/admin/pages/about',
		});
		assert.deepEqual(vividMarkers({ collections }, { vivid: VIVID_SETTINGS }, 'contact.phone', 'https://example.com'), {
			'data-vivid-field': 'settings#contact.phone',
			'data-vivid-edit': 'https://example.com/admin/settings',
		});
	});

	test('a field over 200 characters is left out, not cut short; no origin, no edit address', () => {
		const cms = { vivid: { collection: 'pages', path: 'x'.repeat(200), prefix: 'blocks.0.' } };
		assert.deepEqual(Object.keys(vividMarkers({ collections }, cms, 'heading', 'https://example.com')), ['data-vivid-edit']);
		assert.deepEqual(vividMarkers({ collections }, { vivid: VIVID_SETTINGS }, 'contact.phone', null), { 'data-vivid-field': 'settings#contact.phone' });
	});
});

describe('readDocument\'s tag', () => {
	test('a document read from its file knows its collection and path; one built in code doesn\'t', async () => {
		const { document } = await readDocument(site, 'pages', 'index');
		assert.deepEqual(documentRefOf(document), { collection: 'pages', path: 'index' });
		assert.equal(documentRefOf({ ...document }), null);
		assert.equal(documentRefOf(null), null);
	});
});
