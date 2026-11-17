// Pre-M7 item 8: changing a document's address, on disk (the live half: move-live.test.ts).
// The pure parts (relink.ts, redirects.ts), the rules (move.ts → planMove), and the local
// store's move: the document moves, every link and reference to it is rewritten byte for
// byte, and Site Settings gets the redirect, with chains collapsed.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { SITE_SETTINGS_FILE } from '../src/config.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import { handleCreate } from '../src/editor/server/create.ts';
import { handleMove } from '../src/editor/server/move.ts';
import type { CreateDeleteRefusal, MoveResponse } from '../src/editor/types.ts';
import { parseRedirects, redirectFor, redirectsAfterMove } from '../src/redirects.ts';
import { fileAddress } from '../src/files.ts';
import { relinkHref, relinkRichText } from '../src/relink.ts';
import type { CreateSite } from './helpers/create-site.ts';
import { makeMoveSite } from './helpers/move-site.ts';

const ORIGIN = 'http://site.test';

function request(body: unknown) {
	return new Request(`${ORIGIN}/_caracms/move`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
async function move(s: CreateSite, body: Record<string, unknown>) {
	const r = await handleMove(request(body), localDraftsStore(s.site));
	return { status: r.status, body: (await r.json()) as MoveResponse & CreateDeleteRefusal };
}
const redirects = (s: CreateSite) => parseRedirects(JSON.parse(s.read(SITE_SETTINGS_FILE)).redirects);

describe('relink.ts: which hrefs point at the old address', () => {
	const m = { fromUrl: '/visit', toUrl: '/studio/visit' };
	test('the path, with a trailing slash, a query or an anchor kept', () => {
		assert.equal(relinkHref('/visit', m), '/studio/visit');
		assert.equal(relinkHref('/visit/', m), '/studio/visit/');
		assert.equal(relinkHref('/visit#hours', m), '/studio/visit#hours');
		assert.equal(relinkHref('/visit/?m=1', m), '/studio/visit/?m=1');
	});
	test('never another page, a page under it, a file, or another site', () => {
		for (const href of ['/visitors', '/visit/team', '/visit.pdf', 'https://example.com/visit', '#visit', 'mailto:visit@x.test', '//visit']) assert.equal(relinkHref(href, m), null, href);
	});
	test('rich text: each link to it, escapes kept, others left', () => {
		assert.equal(relinkRichText('[a](/visit) and [b](/about) and [c](/visit#x)', m), '[a](/studio/visit) and [b](/about) and [c](/studio/visit#x)');
		assert.equal(relinkRichText('no links', m), null);
		assert.equal(relinkRichText('[a](/about)', m), null);
		assert.equal(relinkRichText('[a](/x\\)y)', { fromUrl: '/x)y', toUrl: '/z' }), '[a](/z)');
	});
});

describe('M6c Acceptance 18: a page move leaves every /files/ link untouched', () => {
	const key = 'uploads/0123456789ab/visit.pdf';
	const m = { fromUrl: '/visit', toUrl: '/studio/visit' };
	test('relink.ts: a file address, with ?download or a fragment, whatever its name, is never a page link', () => {
		for (const href of [fileAddress(key), fileAddress(key, { download: true }), `${fileAddress(key)}#page=2`, '/files/0123456789ab/visit', '/files/visit']) assert.equal(relinkHref(href, m), null, href);
		assert.equal(relinkRichText(`[a](${fileAddress(key)}) and [b](${fileAddress(key, { download: true })})`, m), null, 'rich text with only file links is not rewritten');
		assert.equal(relinkRichText(`[a](${fileAddress(key)}) [b](/visit)`, m), `[a](${fileAddress(key)}) [b](/studio/visit)`, 'and beside a page link, the file link stays');
	});

	test('the local store: Visit moves, and a document linking to it and to a file keeps the file links byte for byte', async () => {
		const s = makeMoveSite();
		try {
			// A page with a link field, a button and rich text to the PDF (one with ?download), and a link to Visit in each place.
			const rates = `{\n  "title": "Rates",\n  "blocks": [\n    {\n      "type": "links",\n      "link": { "label": "Rates", "href": "${fileAddress(key)}" },\n      "buttons": [{ "label": "Get the PDF", "href": "${fileAddress(key, { download: true })}", "style": "primary" }, { "label": "Visit", "href": "/visit", "style": "primary" }],\n      "body": [{ "p": "Read [the PDF](${fileAddress(key)}#page=2) or [visit](/visit)." }]\n    }\n  ]\n}\n`;
			writeFileSync(join(s.root, 'content/pages/rates.json'), rates);
			const r = await move(s, { collection: 'pages', path: 'visit', to: 'studio/visit' });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.ok(r.body.relinked.some((d) => d.title === 'Rates'), 'Rates was rewritten (its page links), so the walk did reach it');
			assert.equal(s.read('content/pages/rates.json'), rates.replace('"href": "/visit"', '"href": "/studio/visit"').replace('[visit](/visit)', '[visit](/studio/visit)'), 'only the two page links changed');
			assert.ok(s.read('content/pages/rates.json').includes(`"${fileAddress(key)}"`) && s.read('content/pages/rates.json').includes(`"${fileAddress(key, { download: true })}"`) && s.read('content/pages/rates.json').includes(`(${fileAddress(key)}#page=2)`));
		} finally {
			s.cleanup();
		}
	});
});

describe('redirects.ts: the list, chains and the lookup', () => {
	test('the file\'s list is cleaned: not two /paths, going nowhere, or a second entry for a from, dropped', () => {
		assert.deepEqual(
			parseRedirects([{ from: '/a/', to: '/b' }, { from: 'a', to: '/b' }, { from: '/c', to: '/c' }, { from: '/a', to: '/d' }, null, { from: '/e', to: 'https://x.test' }]),
			[{ from: '/a', to: '/b' }],
		);
		assert.deepEqual(parseRedirects('nope'), []);
	});
	test('a move: entries to the old address follow it, an entry from the new one goes, old → new is added', () => {
		const list = [
			{ from: '/a', to: '/b' },
			{ from: '/c', to: '/x' },
		];
		assert.deepEqual(redirectsAfterMove(list, '/b', '/c', true), [
			{ from: '/a', to: '/c' },
			{ from: '/b', to: '/c' },
		]);
		// Moving back where it was: the two entries that would loop go.
		assert.deepEqual(redirectsAfterMove([{ from: '/a', to: '/b' }], '/b', '/a', true), [{ from: '/b', to: '/a' }]);
		// Never live: nothing added, the others still follow it.
		assert.deepEqual(redirectsAfterMove([{ from: '/a', to: '/b' }], '/b', '/c', false), [{ from: '/a', to: '/c' }]);
	});
	test('the lookup ignores a trailing slash and decodes the path', () => {
		const list = [{ from: '/café', to: '/b' }];
		assert.equal(redirectFor(list, '/caf%C3%A9/'), '/b');
		assert.equal(redirectFor(list, '/cafe'), null);
	});
});

describe('the local store: a move on disk', () => {
	let s: CreateSite;
	before(() => {
		s = makeMoveSite();
	});
	after(() => s.cleanup());

	test('Visit to /studio/visit: the file moves, links on Home and its own are rewritten byte for byte, the redirect is added', async () => {
		const homeBefore = s.read('content/pages/index.json');
		const visitBefore = s.read('content/pages/visit.json');
		const r = await move(s, { collection: 'pages', path: 'visit', to: 'studio/visit' });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.equal(r.body.url, '/studio/visit');
		assert.deepEqual(r.body.from, { path: 'visit', file: 'content/pages/visit.json', url: '/visit' });
		assert.deepEqual(r.body.redirect, { from: '/visit', to: '/studio/visit' });
		assert.deepEqual(
			r.body.relinked.map((d) => d.title),
			['Home'],
		);
		assert.equal(existsSync(join(s.root, 'content/pages/visit.json')), false);
		assert.equal(s.read('content/pages/studio/visit.json'), visitBefore.replace('(/visit)', '(/studio/visit)'));
		assert.equal(
			s.read('content/pages/index.json'),
			homeBefore.replace('"href": "/visit"', '"href": "/studio/visit"').replace('"/visit#hours"', '"/studio/visit#hours"').replace('(/visit/?m=1)', '(/studio/visit/?m=1)'),
			'only the three links change: /visitors, the plain-text heading "/visit" and the rest stay',
		);
		// The old redirect to /visit follows it; the one from /studio/visit goes (a page is there now).
		assert.deepEqual(redirects(s), [
			{ from: '/old-visit', to: '/studio/visit' },
			{ from: '/visit', to: '/studio/visit' },
		]);
	});

	test('and on again: the chain collapses, every redirect goes straight to the newest address', async () => {
		const r = await move(s, { collection: 'pages', path: 'studio/visit', to: 'find-us' });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.deepEqual(redirects(s), [
			{ from: '/old-visit', to: '/find-us' },
			{ from: '/visit', to: '/find-us' },
			{ from: '/studio/visit', to: '/find-us' },
		]);
		// The studio folder it left empty is gone, as after a delete.
		assert.equal(existsSync(join(s.root, 'content/pages/studio')), false);
		assert.match(s.read('content/pages/index.json'), /"href": "\/find-us"/);
	});

	test('a case study: references to it in other case studies change, a text that reads the same doesn\'t', async () => {
		const publisherBefore = s.read('content/case-studies/tiny.json');
		const r = await move(s, { collection: 'case-studies', path: 'high-street-coffee', to: 'high-street-roaster' });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.equal(r.body.url, '/work/high-street-roaster');
		assert.equal(s.read('content/case-studies/tiny.json'), publisherBefore.replace('"high-street-coffee"', '"high-street-roaster"').replace('(/work/high-street-coffee)', '(/work/high-street-roaster)'));
		assert.match(s.read('content/case-studies/high-street-roaster.json'), /"client": "high-street-coffee"/, 'a text field is never a reference');
		assert.ok(redirects(s).some((x) => x.from === '/work/high-street-coffee' && x.to === '/work/high-street-roaster'));
	});

	test('a page with pages under it: they move with it (collections under pages, Decision 9), and no group is left behind', async () => {
		const r = await move(s, { collection: 'pages', path: 'about', to: 'studio' });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.ok(existsSync(join(s.root, 'content/pages/studio.json')));
		assert.ok(existsSync(join(s.root, 'content/pages/studio/team.json')));
		assert.ok(!existsSync(join(s.root, 'content/pages/about')), 'the about folder goes with its last page');
		assert.deepEqual(r.body.moved.map((m) => `${m.fromUrl} → ${m.toUrl}`), ['/about → /studio', '/about/team → /studio/team']);
		assert.deepEqual(r.body.redirects, [{ from: '/about', to: '/studio' }, { from: '/about/team', to: '/studio/team' }]);
		// And back: the redirects to /studio… follow, and the ones from /about… go (a page is there again).
		assert.equal((await move(s, { collection: 'pages', path: 'studio', to: 'about' })).status, 200);
		assert.ok(existsSync(join(s.root, 'content/pages/about/team.json')));
		assert.deepEqual(redirects(s).find((x) => x.from === '/studio'), { from: '/studio', to: '/about' });
		assert.equal(redirects(s).find((x) => x.from === '/about'), undefined, 'a page is at /about again');
		assert.equal(redirects(s).find((x) => x.from === '/about/team'), undefined, 'and at /about/team');
	});

	test('"Leave a redirect" unticked (redirect: false): no redirect from the old address; links still follow, and so do redirects to it', async () => {
		const t = makeMoveSite();
		try {
			const r = await move(t, { collection: 'pages', path: 'visit', to: 'studio/visit', redirect: false });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.equal(r.body.redirect, null);
			assert.deepEqual(r.body.relinked.map((d) => d.title), ['Home']);
			assert.deepEqual(redirects(t), [{ from: '/old-visit', to: '/studio/visit' }], 'no /visit → /studio/visit; /old-visit follows it; the one from /studio/visit goes');
		} finally {
			t.cleanup();
		}
	});

	const refusals: { why: string; body: Record<string, unknown>; status: number; code: string }[] = [
		{ why: 'Home', body: { collection: 'pages', path: 'index', to: 'home' }, status: 400, code: 'not-allowed' },
		{ why: 'the same address', body: { collection: 'pages', path: 'contact', to: 'contact' }, status: 400, code: 'same' },
		{ why: 'a taken address', body: { collection: 'pages', path: 'contact', to: 'about' }, status: 409, code: 'address-taken' },
		{ why: 'another collection\'s page there', body: { collection: 'pages', path: 'contact', to: 'work/kiln' }, status: 409, code: 'address-taken' },
		{ why: 'under another collection', body: { collection: 'pages', path: 'contact', to: 'journal/contact' }, status: 400, code: 'below-collection' },
		{ why: 'the editor\'s address', body: { collection: 'pages', path: 'contact', to: 'admin' }, status: 400, code: 'reserved-address' },
		{ why: 'not an address part', body: { collection: 'pages', path: 'contact', to: 'Contact Us' }, status: 400, code: 'bad-name' },
		{ why: 'index', body: { collection: 'pages', path: 'contact', to: 'studio/index' }, status: 400, code: 'index' },
		{ why: 'out of the collection', body: { collection: 'pages', path: 'contact', to: '../x' }, status: 400, code: 'bad-path' },
		{ why: 'nested in a flat collection', body: { collection: 'journal', path: 'apples', to: 'a/b' }, status: 400, code: 'bad-path' },
		{ why: 'a shared block', body: { collection: 'shared', path: 'footer', to: 'foot' }, status: 400, code: 'not-allowed' },
		{ why: 'Site Settings', body: { collection: 'settings', path: 'site-settings', to: 'x' }, status: 400, code: 'not-allowed' },
		{ why: 'no such document', body: { collection: 'pages', path: 'nope', to: 'x' }, status: 404, code: 'not-found' },
		{ why: 'an extra key', body: { collection: 'pages', path: 'contact', to: 'x', title: 'X' }, status: 400, code: 'bad-request' },
		{ why: 'redirect not true or false', body: { collection: 'pages', path: 'contact', to: 'x', redirect: 'no' }, status: 400, code: 'bad-request' },
	];
	for (const r of refusals) {
		test(`refused, nothing changed: ${r.why}`, async () => {
			const settings = s.read(SITE_SETTINGS_FILE);
			const answer = await move(s, r.body);
			assert.equal(answer.status, r.status, JSON.stringify(answer.body));
			assert.equal(answer.body.code, r.code);
			assert.equal(s.read(SITE_SETTINGS_FILE), settings);
		});
	}

	test('GET is 405; another origin is 403', async () => {
		const store = localDraftsStore(s.site);
		assert.equal((await handleMove(new Request(`${ORIGIN}/_caracms/move`), store)).status, 405);
		const foreign = new Request(`${ORIGIN}/_caracms/move`, { method: 'POST', headers: { origin: 'http://evil.test', 'content-type': 'application/json' }, body: '{}' });
		assert.equal((await handleMove(foreign, store)).status, 403);
	});

	test('a new page made at an address that redirected takes the redirect out', async () => {
		assert.ok(redirects(s).some((x) => x.from === '/old-visit'));
		const r = await handleCreate(new Request(`${ORIGIN}/_caracms/create`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ collection: 'pages', path: 'old-visit', title: 'Old visit' }) }), localDraftsStore(s.site));
		assert.equal(r.status, 200);
		assert.equal(redirects(s).find((x) => x.from === '/old-visit'), undefined);
		assert.ok(redirects(s).some((x) => x.from === '/visit'), 'the others stay');
	});

	test('the Site Settings file keeps its other keys as they were written', () => {
		const text = readFileSync(join(s.root, SITE_SETTINGS_FILE), 'utf8');
		assert.match(text, /^\{\n  "title": "Site Settings",\n  "editors": \[\],\n  "redirects": \[\n    \{ "from": /);
	});
});
