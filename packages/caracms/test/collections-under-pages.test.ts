// Collections under pages, carrier A (addresses), checked without a browser:
// - the config's rules for `heldBy` (check 1);
// - a held collection's addresses from its holder's listing, everywhere a listing or a read gives one,
//   following the holder with no restart (checks 4, 5's payload);
// - the holder problems: no addresses, a sentence naming the files (checks 2–3 at the listing level);
// - a hidden holder hides its documents (check 13 at the listing level);
// - the address rules both ways under a holder, and below a prefix as before (checks 8–9);
// - the catch-all's reader (check 16) and the schema's `holds`.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resolveSite, text, type SiteConfig } from '../src/config.ts';
import { collectionSchema } from '../src/content-schema.ts';
import { addressedDocuments, documentAt, filesSource, heldBasesOf, listDocuments, readDocument } from '../src/content.ts';
import { routeOf } from '../src/code-routes.ts';
import { heldBases, withHeldBases } from '../src/held.ts';
import { documentReader } from '../src/read.ts';
import { addressProblem } from '../src/slug.ts';
import { editorSite } from '../src/editor/server/admin-props.ts';
import { planCreate } from '../src/editor/server/create.ts';
import { planMove } from '../src/editor/server/move.ts';
import { WriteRefused } from '../src/editor/server/write.ts';
import { makeCliSite, type CliSite } from './helpers/cli-site.ts';
import { siteRoot, variant } from './helpers/site.ts';

const pages = { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true } as const;
const held = (patch: Record<string, unknown> = {}): SiteConfig =>
	variant({
		collections: {
			pages,
			journal: { kind: 'sections', folder: 'content/journal', heldBy: 'pages', ...patch },
			'case-studies': { kind: 'fields', label: 'Case studies', folder: 'content/case-studies', heldBy: 'pages', component: 'Block.astro', fields: { client: text() } },
			tags: { kind: 'sections', folder: 'content/tags', urlBase: '/tags/' },
		},
	} as never);
const site = resolveSite(held(), siteRoot);

const page = (title: string, extra: Record<string, unknown> = {}) => `${JSON.stringify({ title, ...extra, blocks: [] }, null, 2)}\n`;
const fields = (title: string, extra: Record<string, unknown> = {}) => `${JSON.stringify({ title, ...extra }, null, 2)}\n`;
const demo = () =>
	new Map([
		['content/pages/index.json', page('Home')],
		['content/pages/journal.json', page('Journal', { holds: 'journal' })],
		['content/pages/work.json', page('Work', { holds: 'case-studies' })],
		['content/pages/about.json', page('About')],
		['content/journal/first-post.json', page('First post')],
		['content/journal/second-post.json', page('Second post')],
		['content/case-studies/kiln.json', fields('Kiln')],
		['content/tags/web.json', page('Web')],
	]);
const sourceOf = (files: Map<string, string>) => filesSource(siteRoot, () => files);
const urls = async (files: Map<string, string>, collection: string) => (await listDocuments(site, collection, sourceOf(files))).map((e) => [e.path, e.url]);

describe('the config (check 1)', () => {
	const fails = (patch: Record<string, unknown>, message: RegExp) => assert.throws(() => resolveSite(held(patch), siteRoot), message);

	test('heldBy with urlBase fails naming both; nested on a held collection fails', () => {
		fails({ urlBase: '/journal/' }, /both urlBase \('\/journal\/'\) and heldBy \('pages'\)/);
		fails({ nested: true }, /a collection a page holds is flat/);
	});

	test('heldBy must name a nested section builder', () => {
		fails({ heldBy: 'tags' }, /heldBy names "tags", which isn't a nested section builder/);
		fails({ heldBy: 'nowhere' }, /heldBy names "nowhere", which isn't one of the site's collections/);
		fails({ heldBy: 'case-studies' }, /isn't a nested section builder/);
	});

	test('a held collection has addresses for the config\'s rules: no urlBase needed, an address column allowed and by default', () => {
		assert.equal(site.collections.journal!.urlBase, null, 'resolved from a listing, never the config');
		assert.equal(site.collections.journal!.heldBy, 'pages');
		const cs = resolveSite(
			variant({ collections: { pages, 'case-studies': { kind: 'fields', folder: 'content/case-studies', heldBy: 'pages', component: 'Block.astro', fields: { client: text() }, columns: ['address', 'client'] } } } as never),
			siteRoot,
		);
		assert.deepEqual(cs.collections['case-studies']!.columns, ['address', 'client']);
		assert.throws(
			() => resolveSite(variant({ collections: { pages, team: { kind: 'fields', folder: 'content/team', component: 'Block.astro', fields: { client: text() }, columns: ['address'] } } } as never), siteRoot),
			/no 'address' column/,
		);
	});
});

describe('addresses from the holder (checks 4–5)', () => {
	test('a held document is at its holder\'s address + its slug, in the listing, a read and cms.read', async () => {
		const files = demo();
		assert.deepEqual(await urls(files, 'journal'), [['first-post', '/journal/first-post'], ['second-post', '/journal/second-post']]);
		assert.deepEqual(await urls(files, 'case-studies'), [['kiln', '/work/kiln']]);
		assert.deepEqual(await urls(files, 'tags'), [['web', '/tags/web']]);
		const all = await listDocuments(site, undefined, sourceOf(files));
		assert.equal(all.find((e) => e.path === 'first-post')!.url, '/journal/first-post', 'the full listing too');
		assert.equal(all.find((e) => e.path === 'journal')!.holds, 'journal');
		assert.equal((await readDocument(site, 'journal', 'first-post', sourceOf(files))).entry.url, '/journal/first-post');
		assert.equal((await documentReader(site, sourceOf(files)).document('journal', 'first-post'))!.url, '/journal/first-post');
	});

	test('the holder moves, and the same calls give the new addresses', async () => {
		const files = demo();
		files.delete('content/pages/journal.json');
		files.set('content/pages/about/blog.json', page('Blog', { holds: 'journal' }));
		assert.deepEqual(await urls(files, 'journal'), [['first-post', '/about/blog/first-post'], ['second-post', '/about/blog/second-post']]);
	});

	test('the editor\'s payload carries the resolved base as urlBase, and New document proposes under it', async () => {
		const files = demo();
		const documents = await listDocuments(site, undefined, sourceOf(files));
		const editor = editorSite({ ...site, textStyles: {} } as never, documents as never, 'localhost', { name: 'Site', accent: '#000' } as never);
		const journal = editor.collections.find((c) => c.name === 'journal')!;
		assert.deepEqual([journal.urlBase, journal.heldBy, journal.holder, journal.problem], ['/journal/', 'pages', { collection: 'pages', path: 'journal' }, null]);
		const tags = editor.collections.find((c) => c.name === 'tags')!;
		assert.deepEqual([tags.urlBase, tags.heldBy, tags.problem], ['/tags/', undefined, undefined], 'a prefix collection is as it was');
		assert.equal(planCreate(site, { collection: 'journal', path: 'third', title: 'Third' }, documents).url, '/journal/third');
		assert.equal(planMove(site, { collection: 'journal', path: 'first-post', to: 'renamed' }, documents).move.toUrl, '/journal/renamed');
	});
});

describe('holder problems (checks 2–3)', () => {
	const problem = async (files: Map<string, string>) => {
		const listed = await listDocuments(site, undefined, sourceOf(files));
		const bases = heldBases(site.collections, listed);
		return { base: bases.journal!, urls: listed.filter((e) => e.collection === 'journal').map((e) => e.url), listed };
	};

	test('no page holds it: no addresses, and a sentence that says what to add', async () => {
		const files = demo();
		files.set('content/pages/journal.json', page('Journal'));
		const p = await problem(files);
		assert.deepEqual(p.urls, [null, null]);
		assert.equal(p.base.base, null);
		assert.match(p.base.problem!, /No page holds Journal, so its documents have no addresses .* Add "holds": "journal"/);
	});

	test('two pages hold it: both files named', async () => {
		const files = demo();
		files.set('content/pages/about.json', page('About', { holds: 'journal' }));
		const p = await problem(files);
		assert.deepEqual(p.urls, [null, null]);
		assert.match(p.base.problem!, /content\/pages\/about\.json and content\/pages\/journal\.json both hold Journal/);
	});

	test('Home can\'t hold it', async () => {
		const files = demo();
		files.set('content/pages/journal.json', page('Journal'));
		files.set('content/pages/index.json', page('Home', { holds: 'journal' }));
		const p = await problem(files);
		assert.deepEqual(p.urls, [null, null]);
		assert.match(p.base.problem!, /content\/pages\/index\.json is Home, which can't hold Journal/);
	});

	test('a holder that can\'t be opened (invalid JSON, no title) is named', async () => {
		for (const broken of ['{\n  "title": "Journal",\n  "holds": "journal",\n  "blocks": [\n', '{\n  "holds": "journal",\n  "blocks": []\n}\n']) {
			const files = demo();
			files.set('content/pages/journal.json', broken);
			const p = await problem(files);
			assert.deepEqual(p.urls, [null, null]);
			assert.match(p.base.problem!, /content\/pages\/journal\.json holds Journal, but it can't be opened/);
		}
	});

	test('the editor\'s payload: urlBase null and the sentence; New document and Change address… refuse with it', async () => {
		const files = demo();
		files.set('content/pages/journal.json', page('Journal'));
		const documents = await listDocuments(site, undefined, sourceOf(files));
		const editor = editorSite({ ...site, textStyles: {} } as never, documents as never, 'localhost', { name: 'Site', accent: '#000' } as never);
		const journal = editor.collections.find((c) => c.name === 'journal')!;
		assert.equal(journal.urlBase, null);
		assert.equal(journal.holder, null);
		assert.match(journal.problem!, /No page holds Journal/);
		const refusedWith = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof WriteRefused && e.body.code === 'not-held' && /No page holds Journal/.test(e.message));
		refusedWith(() => planCreate(site, { collection: 'journal', path: 'third', title: 'Third' }, documents));
		refusedWith(() => planMove(site, { collection: 'journal', path: 'first-post', to: 'renamed' }, documents));
	});
});

describe('a hidden holder (check 13)', () => {
	test('hides its documents, naming itself; a hidden page above it does too', async () => {
		const files = demo();
		files.set('content/pages/journal.json', page('Journal', { hidden: true, holds: 'journal' }));
		const listed = await listDocuments(site, 'journal', sourceOf(files));
		assert.deepEqual(listed.map((e) => [e.hidden, e.hiddenBy, e.hiddenByCollection]), [[true, 'journal', 'pages'], [true, 'journal', 'pages']]);
		assert.equal((await documentReader(site, sourceOf(files)).documents('journal')).length, 0, 'cms.read leaves them out');
		assert.equal((await readDocument(site, 'journal', 'first-post', sourceOf(files))).entry.hidden, true);

		files.delete('content/pages/journal.json');
		files.set('content/pages/about.json', page('About', { hidden: true }));
		files.set('content/pages/about/journal.json', page('Journal', { holds: 'journal' }));
		assert.deepEqual((await listDocuments(site, 'journal', sourceOf(files))).map((e) => [e.url, e.hidden]), [['/about/journal/first-post', true], ['/about/journal/second-post', true]]);
	});
});

describe('the address rules under a holder (checks 8–9)', () => {
	const rules = async () => {
		const documents = await listDocuments(site, undefined, sourceOf(demo()));
		const bases = await heldBasesOf(site, sourceOf(demo()));
		const collections = Object.values(site.collections).map((c) => ({ name: c.name, label: c.label, urlBase: bases[c.name]?.base ?? c.urlBase, heldBy: c.heldBy }));
		return (url: string, collection: string) => addressProblem(url, collection, collections, documents);
	};

	test('a page at a held document\'s address, and a held document at a page\'s, are refused naming the other', async () => {
		const problem = await rules();
		assert.deepEqual(problem('/journal/first-post', 'pages'), { code: 'address-taken', message: 'There\'s already a page at /journal/first-post: “First post” in Journal.' });
		const files = demo();
		files.set('content/pages/journal/about.json', page('About the journal'));
		const documents = await listDocuments(site, undefined, sourceOf(files));
		const collections = Object.values(withHeldBases(site, heldBases(site.collections, documents)).collections);
		assert.deepEqual(addressProblem('/journal/about', 'journal', collections, documents), { code: 'address-taken', message: 'There\'s already a page at /journal/about: “About the journal” in Pages.' });
	});

	test('a page under a holder is allowed; under a prefix collection it\'s still below-collection', async () => {
		const problem = await rules();
		assert.equal(problem('/journal/about', 'pages'), null);
		assert.equal(problem('/tags/x', 'pages')?.code, 'below-collection');
	});
});

describe('the catch-all\'s reader (check 16)', () => {
	test('every page and every held and prefix document, leaving out warnings and hidden ones', async () => {
		const files = demo();
		files.set('content/pages/broken.json', '{');
		files.set('content/journal/hidden-post.json', page('Hidden', { hidden: true }));
		const found = await addressedDocuments(site, sourceOf(files));
		assert.deepEqual(
			found.map((d) => d.url),
			// Arrange pages (Decision 7): the pages holding a collection first, then the rest.
			['/', '/journal', '/work', '/about', '/journal/first-post', '/journal/second-post', '/work/kiln', '/tags/web'],
		);
		assert.deepEqual(found.find((d) => d.url === '/work/kiln'), { collection: 'case-studies', path: 'kiln', url: '/work/kiln' });
	});

	test('a prefix collection with its own route is left to it; a held one never is', async () => {
		const pageRoutes = ['[...path].astro', 'tags/[slug].astro', 'journal/[slug].astro'].map((f) => routeOf(f, `src/pages/${f}`)!);
		const found = await addressedDocuments({ ...site, pageRoutes }, sourceOf(demo()));
		assert.ok(!found.some((d) => d.collection === 'tags'), 'tags/[slug].astro serves the tags');
		assert.ok(found.some((d) => d.collection === 'journal'), 'the journal is the catch-all\'s');
	});

	test('a hidden holder: its documents are out of the reader and unanswered, and unhiding brings them back (check 13)', async () => {
		const files = demo();
		files.set('content/pages/journal.json', page('Journal', { hidden: true, holds: 'journal' }));
		const hidden = await addressedDocuments(site, sourceOf(files));
		assert.ok(!hidden.some((d) => d.url.startsWith('/journal')), hidden.map((d) => d.url).join(', '));
		assert.equal(await documentAt(site, '/journal/first-post', sourceOf(files)), null);
		files.set('content/pages/journal.json', page('Journal', { holds: 'journal' }));
		const shown = await addressedDocuments(site, sourceOf(files));
		assert.ok(shown.some((d) => d.url === '/journal/first-post'));
		assert.deepEqual(await documentAt(site, '/journal/first-post', sourceOf(files)), { collection: 'journal', path: 'first-post' });
	});

	test('a request path to its document, or null', async () => {
		const source = sourceOf(demo());
		assert.deepEqual(await documentAt(site, '/journal/first-post/', source), { collection: 'journal', path: 'first-post' });
		assert.deepEqual(await documentAt(site, '/', source), { collection: 'pages', path: 'index' });
		assert.deepEqual(await documentAt(site, '/Work/Kiln', source), { collection: 'case-studies', path: 'kiln' });
		assert.equal(await documentAt(site, '/journal/nope', source), null);
		assert.equal(await documentAt(site, '/%E0%A4%A', source), null);
	});
});

describe('the schema', () => {
	test('a page of the holding collection may say "holds", naming one of the collections it can hold', () => {
		const schema = collectionSchema(site, site.collections.pages!) as { properties: Record<string, { enum?: string[] }> };
		assert.deepEqual(schema.properties.holds!.enum, ['journal', 'case-studies']);
		const journal = collectionSchema(site, site.collections.journal!) as { properties: Record<string, unknown> };
		assert.equal(journal.properties.holds, undefined);
	});
});

describe('validate on the pinned fixture (checks 2, 8, 16a)', () => {
	let s: CliSite;
	before(() => (s = makeCliSite('held-validate')));
	after(() => s.cleanup());
	const errors = () => {
		const r = s.run('validate', '--json');
		return { code: r.code, errors: (JSON.parse(r.stdout) as { errors: { file: string; path: string; message: string }[] }).errors };
	};
	const withFile = (file: string, text: string, check: () => void) => {
		const before = (() => {
			try {
				return s.read(file);
			} catch {
				return null;
			}
		})();
		s.write(file, text);
		try {
			check();
		} finally {
			if (before === null) rmSync(join(s.root, file));
			else s.write(file, before);
		}
	};

	test('two pages holding the journal: an error on both files, exit 1', () => {
		withFile('content/pages/about.json', s.read('content/pages/about.json').replace('"title": "About",\n', '"title": "About",\n  "holds": "journal",\n'), () => {
			const { code, errors: found } = errors();
			assert.equal(code, 1);
			const both = found.filter((e) => /both hold Journal/.test(e.message)).map((e) => e.file);
			assert.deepEqual(both.sort(), ['content/pages/about.json', 'content/pages/journal.json']);
		});
	});

	test('"holds" on a document that isn\'t a page, or naming a collection no page can hold', () => {
		withFile('content/case-studies/high-street-coffee.json', s.read('content/case-studies/high-street-coffee.json').replace(/("title": "[^"]*",\n)/, '$1  "holds": "journal",\n'), () => {
			assert.ok(errors().errors.some((e) => e.file === 'content/case-studies/high-street-coffee.json' && e.path === 'holds' && /"holds" is for a page/.test(e.message)));
		});
		withFile('content/pages/contact.json', s.read('content/pages/contact.json').replace(/("title": "[^"]*",\n)/, '$1  "holds": "shared",\n'), () => {
			assert.ok(errors().errors.some((e) => e.file === 'content/pages/contact.json' && /"holds" names "shared", which isn't a collection a page holds/.test(e.message)));
		});
	});

	test('"holds" on Home: an error naming index.json (check 2)', () => {
		withFile('content/pages/journal.json', s.read('content/pages/journal.json').replace('  "holds": "journal",\n', ''), () => {
			withFile('content/pages/index.json', s.read('content/pages/index.json').replace(/("title": "[^"]*",\n)/, '$1  "holds": "journal",\n'), () => {
				const { code, errors: found } = errors();
				assert.equal(code, 1);
				assert.ok(found.some((e) => e.file === 'content/pages/index.json' && /is Home, which can't hold Journal/.test(e.message)), JSON.stringify(found));
			});
		});
	});

	test('a holder that is invalid JSON, or has no title: an error naming that file, exit 1 (check 2)', () => {
		const journal = s.read('content/pages/journal.json');
		for (const broken of [journal.slice(0, journal.indexOf('"blocks"')), journal.replace(/  "title": "Journal",\n/, '')]) {
			withFile('content/pages/journal.json', broken, () => {
				const { code, errors: found } = errors();
				assert.equal(code, 1);
				assert.ok(found.some((e) => e.file === 'content/pages/journal.json' && /holds Journal, but it can't be opened/.test(e.message)), JSON.stringify(found));
			});
		}
	});

	test('"holds" on a shared block or on Site Settings: an error on that file (check 2)', () => {
		withFile('content/shared/footer.json', s.read('content/shared/footer.json').replace(/("title": "[^"]*",\n)/, '$1  "holds": "journal",\n'), () => {
			assert.ok(errors().errors.some((e) => e.file === 'content/shared/footer.json' && e.path === 'holds'), JSON.stringify(errors().errors));
		});
		withFile('content/site-settings.json', s.read('content/site-settings.json').replace(/("title": "[^"]*",\n)/, '$1  "holds": "journal",\n'), () => {
			assert.ok(errors().errors.some((e) => e.file === 'content/site-settings.json' && /holds/.test(`${e.path} ${e.message}`)), JSON.stringify(errors().errors));
		});
	});

	test('no page holding the journal: an error naming its folder', () => {
		withFile('content/pages/journal.json', s.read('content/pages/journal.json').replace('  "holds": "journal",\n', ''), () => {
			const { code, errors: found } = errors();
			assert.equal(code, 1);
			assert.ok(found.some((e) => e.file === 'content/journal' && /No page holds Journal/.test(e.message)));
		});
	});

	test('a page at a held document\'s address: an error on both files', () => {
		withFile('content/pages/journal/notes-from-the-ridge.json', page('Notes'), () => {
			const found = errors().errors.filter((e) => /Two documents can't share an address/.test(e.message)).map((e) => e.file);
			assert.deepEqual(found.sort(), ['content/journal/notes-from-the-ridge.json', 'content/pages/journal/notes-from-the-ridge.json']);
		});
	});

	test('a prefix collection with its own route file: validate is clean, no shadowing (check 16)', () => {
		const config = s.read('caracms.config.ts');
		const withNotes = config
			.replace("import { defineSite } from 'caracms/config';", "import { defineSite, text } from 'caracms/config';")
			.replace("journal: { kind: 'sections', folder: 'content/journal', heldBy: 'pages', fields: journalFields },", "journal: { kind: 'sections', folder: 'content/journal', heldBy: 'pages', fields: journalFields },\n\t\tnotes: { kind: 'fields', folder: 'content/notes', urlBase: '/notes/', component: 'src/collections/CaseStudy.astro', fields: { blurb: text() } },");
		assert.notEqual(withNotes, config);
		withFile('caracms.config.ts', withNotes, () => {
			withFile('content/notes/alpha.json', '{\n  "title": "Alpha",\n  "blurb": "A note."\n}\n', () => {
				const baseline = errors();
				withFile('src/pages/notes/[slug].astro', '---\nexport const getStaticPaths = () => [];\n---\n', () => {
					const { errors: found } = errors();
					assert.deepEqual(found, baseline.errors, 'the route adds nothing: it is the collection\'s own');
					assert.ok(!found.some((e) => /shadow/i.test(e.message)), JSON.stringify(found));
				});
			});
		});
	});

	test('a route left at the journal\'s address (check 16a): one error naming the file, none on the posts', () => {
		withFile('src/pages/journal/[slug].astro', '---\nexport const getStaticPaths = () => [];\n---\n', () => {
			const found = errors().errors;
			const left = found.filter((e) => e.file === 'src/pages/journal/[slug].astro');
			assert.equal(left.length, 1, JSON.stringify(found));
			assert.equal(left[0]!.message, 'src/pages/journal/[slug].astro serves /journal/…, where the Journal page\'s Journal documents are now. Delete it: the catch-all serves them.');
			assert.ok(!found.some((e) => e.file.startsWith('content/journal/')), JSON.stringify(found));
		});
	});
});
