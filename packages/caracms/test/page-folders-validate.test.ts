// Page folders, acceptance check 14: `caracms validate` does
// what the table "What `validate` and the reader do with `pageFolders`" says for each row —
// errors for the shape rows, warnings for the rest, `--fix` pruning each and saying how many,
// never a token that names a folder; and a site field named `pageFolders` is refused by the config.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { resolveSite, SITE_SETTINGS_FILE, text, type SiteConfig } from '../src/config.ts';
import { pageLayout } from '../src/cli/validate.ts';
import { PAGE_FOLDERS_SHAPE, readPageFolders } from '../src/page-folders.ts';
import { makeCliSite, type CliSite } from './helpers/cli-site.ts';
import { config, siteRoot } from './helpers/site.ts';

/** The pinned fixture's Pages paths: about (with about/team), contact, index, journal, services (a group), visit, work. */
const PATHS = ['index', 'about', 'about/team', 'contact', 'journal', 'services/branding', 'services/print', 'services/websites', 'visit', 'work'];
const company = (pages: string[]) => ({ id: 'company', name: 'Company', pages });

describe('readPageFolders: the shape check', () => {
	test('nothing saved is no folders and no problem', () => {
		assert.deepEqual(readPageFolders(undefined), { folders: {}, problems: [] });
	});
	test('not an object: one problem for the whole value', () => {
		assert.deepEqual(readPageFolders(['x']).problems, [{ level: null, message: 'isn’t an object of levels' }]);
	});
	test('each bad level is its own problem, and the good levels are kept', () => {
		const { folders, problems } = readPageFolders({
			'': [{ id: 'company', name: '  Company ', pages: ['about', 'about'] }],
			about: 'x',
			services: [{ id: 'Not A Slug', name: 'X', pages: [] }],
			work: [{ id: 'a', name: '', pages: [] }],
			visit: [{ id: 'a', name: 'x'.repeat(61), pages: [] }],
			journal: [{ id: 'a', name: 'A', pages: [] }, { id: 'a', name: 'B', pages: [] }],
			contact: [{ id: 'a', name: 'A', pages: [1] }],
			team: [{ id: 'a', name: 'A', pages: [], colour: 'red' }],
		});
		assert.deepEqual(folders, { '': [company(['about'])] }, 'the name trimmed, the repeat dropped');
		assert.deepEqual(
			problems.map((p) => p.level),
			['about', 'services', 'work', 'visit', 'journal', 'contact', 'team'],
		);
		assert.match(problems.find((p) => p.level === 'services')!.message, /id isn’t an address part/);
		assert.match(problems.find((p) => p.level === 'work')!.message, /no name, or one over 60 characters/);
		assert.match(problems.find((p) => p.level === 'visit')!.message, /no name, or one over 60 characters/);
		assert.match(problems.find((p) => p.level === 'journal')!.message, /two folders have the id "a"/);
		assert.match(problems.find((p) => p.level === 'contact')!.message, /pages aren’t a list of slugs/);
		assert.match(problems.find((p) => p.level === 'team')!.message, /"colour", which a folder doesn’t take/);
	});
});

describe('pageLayout: one row of the table at a time', () => {
	const only = (order: Record<string, string[]> | null, folders: unknown) => pageLayout(order, folders, PATHS);

	test('a slug in a folder naming no page or group: warned, pruned', () => {
		const r = only(null, { '': [company(['about', 'gone'])] });
		assert.equal(r.warnings.length, 1);
		assert.equal(r.warnings[0]!.path, 'pageFolders[""][0].pages[1]');
		assert.match(r.warnings[0]!.message, /The folder "Company" files "gone" in the top level, where there's no page or group by that name/);
		assert.deepEqual(r.folders, { '': [company(['about'])] });
		assert.equal(r.foldersPruned, 1);
	});

	test('a group counts as existing, at the top level and under a page', () => {
		const r = only(null, { '': [company(['services', 'about'])], about: [{ id: 'people', name: 'People', pages: ['team'] }] });
		assert.deepEqual(r.warnings, []);
		assert.equal(r.foldersPruned, 0);
	});

	test('index in a folder: warned, pruned', () => {
		const r = only(null, { '': [company(['index', 'about'])] });
		assert.equal(r.warnings[0]!.path, 'pageFolders[""][0].pages[0]');
		assert.match(r.warnings[0]!.message, /files "index", the home page, which is never filed/);
		assert.deepEqual(r.folders, { '': [company(['about'])] });
		assert.equal(r.foldersPruned, 1);
	});

	test('a slug in two folders: the first keeps it, the later one is pruned', () => {
		const r = only(null, { '': [company(['about', 'contact']), { id: 'more', name: 'More', pages: ['contact', 'work'] }] });
		assert.equal(r.warnings.length, 1);
		assert.equal(r.warnings[0]!.path, 'pageFolders[""][1].pages[0]');
		assert.match(r.warnings[0]!.message, /"contact" is in two folders in the top level, "Company" and "More"; the first keeps it/);
		assert.deepEqual(r.folders, { '': [company(['about', 'contact']), { id: 'more', name: 'More', pages: ['work'] }] });
		assert.equal(r.foldersPruned, 1);
	});

	test('a slug both in a folder and in its level\'s list: the list entry is pruned, the token kept', () => {
		const r = only({ '': ['(company)', 'about', 'work'] }, { '': [company(['about'])] });
		assert.equal(r.warnings.length, 1);
		assert.equal(r.warnings[0]!.path, 'pageOrder[""]');
		assert.match(r.warnings[0]!.message, /"about" is in the folder "Company" and listed in the top level's order too/);
		assert.deepEqual(r.order, { '': ['(company)', 'work'] });
		assert.equal(r.orderPruned, 1);
		assert.equal(r.foldersPruned, 0);
	});

	test('a folder with nothing to show: pruned with its token', () => {
		const r = only({ '': ['work', '(empty)', '(company)'] }, { '': [company(['about']), { id: 'empty', name: 'Empty', pages: [] }] });
		assert.equal(r.warnings.length, 1);
		assert.equal(r.warnings[0]!.path, 'pageFolders[""][1]');
		assert.match(r.warnings[0]!.message, /The folder "Empty" in the top level has nothing to show.*prunes it and its place in the order/);
		assert.deepEqual(r.folders, { '': [company(['about'])] });
		assert.deepEqual(r.order, { '': ['work', '(company)'] });
		assert.equal(r.foldersPruned, 1);
		assert.equal(r.orderPruned, 1);
	});

	test('a folder whose every slug names nothing: each slug warned, then the folder', () => {
		const r = only({ '': ['(gone)'] }, { '': [{ id: 'gone', name: 'Gone', pages: ['old', 'older'] }] });
		assert.deepEqual(r.warnings.map((w) => w.path), ['pageFolders[""][0].pages[0]', 'pageFolders[""][0].pages[1]', 'pageFolders[""][0]']);
		assert.deepEqual(r.folders, {});
		assert.deepEqual(r.order, {});
		assert.equal(r.foldersPruned, 3);
		assert.equal(r.orderPruned, 1);
	});

	test('a token naming no folder at its level: warned, pruned; one naming a folder is never pruned', () => {
		const r = only({ '': ['(company)', '(ghost)', 'work'], about: ['(company)'] }, { '': [company(['about'])] });
		assert.deepEqual(r.warnings.map((w) => w.path), ['pageOrder[""]', 'pageOrder["about"]']);
		assert.match(r.warnings[0]!.message, /folder token "\(ghost\)" in the top level, where there's no folder with the id "ghost"/);
		assert.match(r.warnings[1]!.message, /folder token "\(company\)" in \/about/);
		assert.deepEqual(r.order, { '': ['(company)', 'work'] });
		assert.equal(r.orderPruned, 2);
	});

	test('a pageFolders level naming no page or group: warned, pruned', () => {
		const r = only(null, { '': [company(['about'])], nowhere: [{ id: 'x', name: 'X', pages: ['a'] }] });
		assert.equal(r.warnings.length, 1);
		assert.equal(r.warnings[0]!.path, 'pageFolders["nowhere"]');
		assert.match(r.warnings[0]!.message, /Folders are saved for \/nowhere, where there are no pages/);
		assert.deepEqual(r.folders, { '': [company(['about'])] });
		assert.equal(r.foldersPruned, 1);
	});

	test('a folder with no token: nothing', () => {
		const r = only({ '': ['work'] }, { '': [company(['about'])] });
		assert.deepEqual(r.warnings, []);
		assert.equal(r.orderPruned + r.foldersPruned, 0);
	});

	test('with a shape error, tokens at that level are left alone and the folders aren\'t written back', () => {
		const r = only({ '': ['(company)', '(anything)'] }, { '': [{ id: 'Bad Id', name: 'X', pages: [] }], about: [{ id: 'people', name: 'People', pages: ['gone'] }] });
		assert.deepEqual(r.warnings.map((w) => w.path), ['pageFolders["about"][0].pages[0]', 'pageFolders["about"][0]']);
		assert.equal(r.folders, null);
		assert.equal(r.foldersPruned, 0);
		assert.deepEqual(r.order, { '': ['(company)', '(anything)'] });
		assert.equal(r.orderPruned, 0);
	});
});

describe('caracms validate and --fix on page folders (check 14)', () => {
	let s: CliSite;
	let base: Record<string, unknown>;
	before(() => {
		s = makeCliSite('page-folders');
		base = JSON.parse(s.read(SITE_SETTINGS_FILE)) as Record<string, unknown>;
	});
	after(() => s.cleanup());
	const write = (extra: Record<string, unknown>) => s.write(SITE_SETTINGS_FILE, `${JSON.stringify({ ...base, ...extra }, null, 2)}\n`);
	const saved = () => JSON.parse(s.read(SITE_SETTINGS_FILE)) as Record<string, unknown>;

	test('a shape error is an error with the expected-shape sentence (exit 1); --fix leaves pageFolders alone', () => {
		const folders = { '': [{ id: 'Not A Slug', name: 'Company', pages: ['about'] }] };
		write({ pageFolders: folders, pageOrder: { '': ['(not-a-slug)', 'work'] } });
		const r = s.run('validate');
		assert.equal(r.code, 1, r.stdout);
		assert.ok(r.stdout.includes(`content/site-settings.json › pageFolders[""]: ${PAGE_FOLDERS_SHAPE}; at the top level, folder 1’s id isn’t an address part.`), r.stdout);
		const fixed = s.run('validate', '--fix');
		assert.doesNotMatch(fixed.stdout, /pruned/);
		assert.deepEqual(saved().pageFolders, folders);
		assert.deepEqual(saved().pageOrder, { '': ['(not-a-slug)', 'work'] }, 'the token at a level with a bad shape is kept');
	});

	test('every warning row at once: warned (exit 0), --fix prunes each and says how many, the token kept', () => {
		write({
			pageOrder: { '': ['(company)', 'about', '(empty)', '(ghost)', 'work'] },
			pageFolders: {
				'': [
					{ id: 'company', name: 'Company', pages: ['about', 'gone', 'index', 'contact'] },
					{ id: 'more', name: 'More', pages: ['contact', 'services'] },
					{ id: 'empty', name: 'Empty', pages: ['nope'] },
				],
				about: [{ id: 'people', name: 'People', pages: ['team'] }],
				nowhere: [{ id: 'x', name: 'X', pages: ['a'] }],
			},
		});
		const r = s.run('validate');
		assert.equal(r.code, 0, r.stdout);
		for (const line of [
			/pageFolders\[""\]\[0\]\.pages\[1\]: The folder "Company" files "gone"/,
			/pageFolders\[""\]\[0\]\.pages\[2\]: The folder "Company" files "index", the home page/,
			/pageFolders\[""\]\[1\]\.pages\[0\]: "contact" is in two folders/,
			/pageFolders\[""\]\[2\]\.pages\[0\]: The folder "Empty" files "nope"/,
			/pageFolders\[""\]\[2\]: The folder "Empty" in the top level has nothing to show/,
			/pageFolders\["nowhere"\]: Folders are saved for \/nowhere/,
			/pageOrder\[""\]: "about" is in the folder "Company"/,
			/pageOrder\[""\]: The Pages tree's order has the folder token "\(ghost\)"/,
		]) assert.match(r.stdout, line);
		const fixed = s.run('validate', '--fix');
		assert.match(fixed.stdout, /pruned 3 page-order entries \(content\/site-settings\.json\)/);
		assert.match(fixed.stdout, /pruned 6 page-folder entries \(content\/site-settings\.json\)/);
		assert.deepEqual(saved().pageOrder, { '': ['(company)', 'work'] });
		assert.deepEqual(saved().pageFolders, {
			'': [
				{ id: 'company', name: 'Company', pages: ['about', 'contact'] },
				{ id: 'more', name: 'More', pages: ['services'] },
			],
			about: [{ id: 'people', name: 'People', pages: ['team'] }],
		});
		const again = s.run('validate');
		assert.doesNotMatch(again.stdout, /pageOrder|pageFolders/);
		assert.match(again.stdout, /caracms validate: 0 errors, 2 warnings\./);
	});
});

describe('pageFolders is reserved (check 14)', () => {
	test('a site field named pageFolders is refused with the reserved-keys sentence', () => {
		assert.throws(
			() => resolveSite({ ...(config as SiteConfig), settings: { fields: { pageFolders: text() } } } as SiteConfig, siteRoot),
			/settings: "pageFolders" is one of Site Settings' own keys \(title, editors, brand, seo, googleTag, formRecipients, redirects, pageOrder, pageFolders, collectionOrder, formWords\); name the field something else\./,
		);
	});
});
