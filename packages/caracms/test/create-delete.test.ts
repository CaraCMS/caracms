// M5a Phase 3: creating and deleting documents in local mode (on disk), the address
// rules (slug.ts) and the two routes' handling. A security boundary like the write
// route: every path a create or delete must refuse is refused, and nothing is written
// or removed outside the collection's folder. Live mode's half: live-create-delete.test.ts.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { listDocuments } from '../src/content.ts';
import { createOnDisk, handleCreate, handleDelete, planCreate } from '../src/editor/server/create.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import type { CreateDeleteRefusal, CreateResponse, DeleteResponse } from '../src/editor/types.ts';
import { addressProblem, isSlug, SLUG_MAX, slugify } from '../src/slug.ts';
import { makeCreateSite, REFUSED_CREATES, REFUSED_DELETES, type CreateSite } from './helpers/create-site.ts';

const ORIGIN = 'http://localhost:4326';
let s: CreateSite;
let store: ReturnType<typeof localDraftsStore>;

before(() => {
	s = makeCreateSite();
	store = localDraftsStore(s.site);
});
after(() => s.cleanup());

function post(route: 'create' | 'delete', body: unknown, init: { headers?: Record<string, string>; method?: string; raw?: string } = {}) {
	const method = init.method ?? 'POST';
	const request = new Request(`${ORIGIN}/_caracms/${route}`, {
		method,
		headers: { 'content-type': 'application/json', ...init.headers },
		body: method === 'GET' ? undefined : (init.raw ?? JSON.stringify(body)),
	});
	return route === 'create' ? handleCreate(request, store) : handleDelete(request, store);
}

async function answer<T>(response: Response, status: number): Promise<T> {
	const body = (await response.clone().json()) as T;
	assert.equal(response.status, status, JSON.stringify(body));
	return body;
}

const exists = (file: string) => existsSync(join(s.root, file));
/** Every file under the site and the folder outside it, for "nothing else changed". */
const snapshot = () =>
	[s.root, s.outside].flatMap((dir) => (readdirSync(dir, { recursive: true }) as string[]).sort().map((f) => `${dir}/${f}`));

describe('addresses from names (Decision 11; slug.ts, browser-safe)', () => {
	test('lower case, accents folded, & as "and", other runs one hyphen, trimmed', () => {
		assert.equal(slugify('Salt & Pepper.'), 'salt-and-pepper');
		assert.equal(slugify('Bread & Butter'), 'bread-and-butter');
		assert.equal(slugify('Café Ölé'), 'cafe-ole');
		assert.equal(slugify('Straße, Œuvre, Ærø, Łódź'), 'strasse-oeuvre-aero-lodz');
		assert.equal(slugify('  --Hello,   World!!  '), 'hello-world');
		assert.equal(slugify('Visit'), 'visit');
		assert.equal(slugify('2026 in review'), '2026-in-review');
		assert.equal(slugify('Ελλάδα'), 'ελλαδα', 'letters of any script are letters');
	});

	test('at most 60 characters, never ending on a hyphen; nothing left is ""', () => {
		const long = slugify('A very long name that keeps going and going well past sixty characters in all');
		assert.ok(long.length <= SLUG_MAX, long);
		assert.doesNotMatch(long, /-$/);
		assert.equal(slugify(`${'a'.repeat(59)} b`), 'a'.repeat(59));
		assert.equal(slugify('!!!'), '');
		assert.equal(slugify('& '), 'and');
	});

	test('isSlug: a part slugify leaves as it is', () => {
		for (const ok of ['visit', 'kitchen-pottery', '2026', 'ελλαδα']) assert.equal(isSlug(ok), true, ok);
		for (const bad of ['', 'Visit', 'a b', '-a', 'a-', 'a--b', 'a_b', '..', '.hidden', 'x'.repeat(61)]) assert.equal(isSlug(bad), false, bad);
	});

	test("addressProblem: the editor's own, strictly below another collection's base, or taken", () => {
		const collections = [
			{ name: 'pages', label: 'Pages', urlBase: '/' },
			{ name: 'journal', label: 'Journal', urlBase: '/journal/' },
			{ name: 'case-studies', label: 'Case studies', urlBase: '/work/' },
			{ name: 'shared', label: 'Shared blocks', urlBase: null },
		];
		const docs = [{ collection: 'pages', path: 'about', url: '/about' }];
		const problem = (url: string, collection = 'pages') => addressProblem(url, collection, collections, docs)?.code ?? null;
		assert.equal(problem('/admin'), 'reserved-address');
		assert.equal(problem('/admin/x'), 'reserved-address');
		assert.equal(problem('/_caracms/x'), 'reserved-address');
		assert.equal(problem('/administration'), null);
		assert.equal(problem('/files'), 'reserved-address', 'the library\'s files (M6c Decision 3)');
		assert.equal(problem('/files/x'), 'reserved-address');
		assert.equal(problem('/Files/x'), 'reserved-address', 'compared without case');
		assert.equal(problem('/filesystem'), null);
		assert.match(addressProblem('/files', 'pages', collections, docs)!.message, /library's files/);
		assert.equal(problem('/work'), null, 'exactly at another collection\'s base is allowed');
		assert.equal(problem('/work/x'), 'below-collection');
		assert.equal(problem('/journal/x'), 'below-collection');
		assert.equal(problem('/work/x', 'case-studies'), null, 'its own base');
		assert.equal(problem('/About'), 'address-taken', 'compared without case');
		assert.equal(addressProblem('/about', 'pages', collections, docs)?.message, "There's already a page at /about.");
	});
});

describe('creating on disk (Decision 11)', () => {
	test('creating pages/studio/visit makes content/pages/studio/visit.json; deleting it removes the file and the empty studio/ folder', async () => {
		const made = await answer<CreateResponse>(await post('create', { collection: 'pages', path: 'studio/visit', title: 'Visit' }), 200);
		assert.deepEqual({ ...made, version: typeof made.version }, { ok: true, collection: 'pages', path: 'studio/visit', file: 'content/pages/studio/visit.json', url: '/studio/visit', version: 'string' });
		assert.equal(s.read('content/pages/studio/visit.json'), '{\n  "$schema": "../../../schemas/pages.schema.json",\n  "title": "Visit",\n  "blocks": []\n}\n');
		const opened = await store.read('pages', 'studio/visit');
		assert.deepEqual(opened.document, { title: 'Visit', blocks: [] });
		assert.ok((await store.list()).some((d) => d.file === 'content/pages/studio/visit.json'));

		const gone = await answer<DeleteResponse>(await post('delete', { collection: 'pages', path: 'studio/visit' }), 200);
		assert.deepEqual(gone, { ok: true, collection: 'pages', path: 'studio/visit', file: 'content/pages/studio/visit.json' });
		assert.equal(exists('content/pages/studio/visit.json'), false);
		assert.equal(exists('content/pages/studio'), false, 'the emptied folder goes');
		assert.equal(exists('content/pages'), true);
	});

	test('a fields document is { "title" }; a shared block { "title", "block": { "type" } }', async () => {
		await answer(await post('create', { collection: 'case-studies', path: 'kitchen-pottery', title: 'Kitchen pottery' }), 200);
		assert.equal(s.read('content/case-studies/kitchen-pottery.json'), '{\n  "$schema": "../../schemas/case-studies.schema.json",\n  "title": "Kitchen pottery"\n}\n');
		const made = await answer<CreateResponse>(await post('create', { collection: 'shared', path: 'banner', title: 'Banner', blockType: 'cta' }), 200);
		assert.equal(made.url, null);
		assert.equal(s.read('content/shared/banner.json'), '{\n  "$schema": "../../schemas/shared.schema.json",\n  "title": "Banner",\n  "block": {\n    "type": "cta"\n  }\n}\n');
		const shared = await store.read('shared', 'banner');
		assert.equal((shared.document as { block: { type: string } }).block.type, 'cta');
	});

	test('"Create a page at /services" beside the group, and a group named after a page puts the new page under it', async () => {
		await answer(await post('create', { collection: 'pages', path: 'services', title: 'Services' }), 200);
		assert.equal(exists('content/pages/services.json'), true);
		await answer(await post('create', { collection: 'pages', path: 'contact/directions', title: 'Directions' }), 200);
		assert.equal(exists('content/pages/contact/directions.json'), true);
		const urls = (await store.list()).map((d) => d.url);
		assert.ok(urls.includes('/services') && urls.includes('/contact/directions'));
	});

	test('every path a create must refuse is refused, and nothing on disk changes', async () => {
		const before = snapshot();
		for (const { why, body, status, code } of REFUSED_CREATES) {
			const res = await post('create', body);
			const refusal = await answer<CreateDeleteRefusal>(res, status);
			assert.equal(refusal.code, code, `${why}: ${refusal.error}`);
			assert.equal(typeof refusal.error, 'string');
		}
		assert.deepEqual(snapshot(), before);
		assert.equal(existsSync(join(s.outside, 'x.json')), false, 'nothing through the link');
	});

	test('the refusals say what\'s wrong in plain words', async () => {
		const taken = await answer<CreateDeleteRefusal>(await post('create', { collection: 'case-studies', path: 'kiln', title: 'Kiln' }), 409);
		assert.equal(taken.error, "There's already a page at /work/kiln: “Kiln (by hand)” in Pages.");
		const exists409 = await answer<CreateDeleteRefusal>(await post('create', { collection: 'pages', path: 'services/print', title: 'Print' }), 409);
		assert.equal(exists409.error, "There's already a page at /services/print.");
		const below = await answer<CreateDeleteRefusal>(await post('create', { collection: 'pages', path: 'work/x', title: 'X' }), 400);
		assert.match(below.error, /under Case studies \(\/work\/\)/);
		const index = await answer<CreateDeleteRefusal>(await post('create', { collection: 'pages', path: 'index', title: 'X' }), 400);
		assert.match(index.error, /"index" is kept for Home/);
		const name = await answer<CreateDeleteRefusal>(await post('create', { collection: 'pages', path: 'Studio/visit', title: 'X' }), 400);
		assert.match(name.error, /"Studio" can't be part of an address; "studio" can/);
	});

	test('a folder that already has documents keeps its name, whatever it is', async () => {
		const odd = join(s.root, 'content/pages/Old_Folder');
		await import('node:fs').then((fs) => fs.mkdirSync(odd));
		writeFileSync(join(odd, 'one.json'), '{ "title": "One", "blocks": [] }\n');
		await answer(await post('create', { collection: 'pages', path: 'Old_Folder/two', title: 'Two' }), 200);
		assert.equal(exists('content/pages/Old_Folder/two.json'), true);
		await answer(await post('delete', { collection: 'pages', path: 'Old_Folder/two' }), 200);
		await answer(await post('delete', { collection: 'pages', path: 'Old_Folder/one' }), 200);
		assert.equal(exists('content/pages/Old_Folder'), false);
	});

	test('the shared folder is made on the first shared block, and kept when the last one goes', async () => {
		const t = makeCreateSite();
		try {
			rmSync(join(t.root, 'content/shared'), { recursive: true });
			for (const page of ['index', 'about']) {
				const file = join(t.root, `content/pages/${page}.json`);
				writeFileSync(file, readFileSync(file, 'utf8').replace(/,\s*\{\s*"shared": "footer"\s*\}/, ''));
			}
			const local = localDraftsStore(t.site);
			await local.create({ collection: 'shared', path: 'banner', title: 'Banner', blockType: 'text' });
			assert.equal(existsSync(join(t.root, 'content/shared/banner.json')), true);
			await local.delete({ collection: 'shared', path: 'banner' });
			assert.equal(existsSync(join(t.root, 'content/shared/banner.json')), false);
			assert.equal(existsSync(join(t.root, 'content/shared')), true, "the collection's own folder stays, empty");
		} finally {
			t.cleanup();
		}
	});

	test('an exclusive create: a file that appears after the check is never replaced, and no temp file is left', async () => {
		const plan = planCreate(s.site, { collection: 'pages', path: 'race', title: 'Race' }, await listDocuments(s.site));
		writeFileSync(join(s.root, 'content/pages/race.json'), '{ "title": "Got here first", "blocks": [] }\n');
		await assert.rejects(createOnDisk(s.site, plan), (e: Error & { status?: number; body?: { code?: string } }) => e.status === 409 && e.body?.code === 'exists');
		assert.equal(s.read('content/pages/race.json'), '{ "title": "Got here first", "blocks": [] }\n');
		assert.deepEqual(readdirSync(join(s.root, 'content/pages')).filter((f) => f.endsWith('.tmp')), []);
		rmSync(join(s.root, 'content/pages/race.json'));
	});
});

describe('deleting on disk (Decision 12)', () => {
	test('every delete it must refuse is refused, and nothing on disk changes', async () => {
		const before = snapshot();
		for (const { why, body, status, code } of REFUSED_DELETES) {
			const refusal = await answer<CreateDeleteRefusal>(await post('delete', body), status);
			assert.equal(refusal.code, code, `${why}: ${refusal.error}`);
		}
		assert.deepEqual(snapshot(), before);
		assert.equal(existsSync(join(s.outside, 'secret.json')), true);
	});

	test('a shared block in use names where; Home and Site Settings say why', async () => {
		const inUse = await answer<CreateDeleteRefusal>(await post('delete', { collection: 'shared', path: 'footer' }), 409);
		assert.match(inUse.error, /^Footer is used on .+ and .+, so it can't be deleted\. Take it off those pages first\.$/);
		assert.deepEqual(inUse.usedOn?.map((u) => `${u.collection}/${u.path}`).sort(), ['pages/about', 'pages/index']);
		assert.ok(inUse.usedOn?.every((u) => typeof u.title === 'string' && u.title.length > 0));
		assert.equal((await answer<CreateDeleteRefusal>(await post('delete', { collection: 'pages', path: 'index' }), 400)).error, "Home can't be deleted.");
		assert.equal((await answer<CreateDeleteRefusal>(await post('delete', { collection: 'settings', path: 'site-settings' }), 400)).error, "Site Settings can't be deleted.");
	});

	test('a shared block nothing uses can be deleted', async () => {
		await answer(await post('delete', { collection: 'shared', path: 'spare' }), 200);
		assert.equal(exists('content/shared/spare.json'), false);
	});

	test('a page with pages under it can be deleted: they stay, as a group', async () => {
		await answer(await post('delete', { collection: 'pages', path: 'about' }), 200);
		assert.equal(exists('content/pages/about.json'), false);
		assert.equal(exists('content/pages/about/team.json'), true);
		const list = await store.list();
		assert.ok(list.some((d) => d.path === 'about/team'));
		assert.ok(!list.some((d) => d.path === 'about'));
	});

	test('re-creating a deleted page writes the new document', async () => {
		await answer(await post('delete', { collection: 'journal', path: 'apples' }), 200);
		await answer(await post('create', { collection: 'journal', path: 'apples', title: 'Apples again' }), 200);
		assert.equal(s.read('content/journal/apples.json'), '{\n  "$schema": "../../schemas/journal.schema.json",\n  "title": "Apples again",\n  "blocks": []\n}\n');
	});
});

describe('the routes: POST, JSON, same origin (as the write route)', () => {
	test('another method is 405; another type 415; another site 403; a body that isn\'t JSON 400', async () => {
		for (const route of ['create', 'delete'] as const) {
			const get = await post(route, null, { method: 'GET' });
			assert.equal(get.status, 405);
			assert.equal(get.headers.get('allow'), 'POST');
			assert.equal((await post(route, {}, { headers: { 'content-type': 'text/plain' } })).status, 415);
			assert.equal((await post(route, { collection: 'pages', path: 'x', title: 'X' }, { headers: { origin: 'https://evil.test' } })).status, 403);
			assert.equal((await post(route, { collection: 'pages', path: 'x', title: 'X' }, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
			assert.equal((await post(route, null, { raw: '{nope' })).status, 400);
			assert.equal((await post(route, null, { raw: 'x'.repeat(20_000) })).status, 413);
			assert.equal((await post(route, [])).status, 400);
		}
		assert.equal(exists('content/pages/x.json'), false);
	});
});
