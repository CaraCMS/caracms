// Page folders on the Arrange screen's model: the Apply's
// request (moves, order with tokens, folders) and the folder lines for filing, a new folder,
// Remove, the two switch actions and a folder moved across levels (Decisions 4–7, checks 15–19),
// and re-planning on a fresh listing that keeps the person's folder work and takes in the
// other arranger's (Decision 12, check 20).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addFolder, buildTree, makePlan, moveNode, putIn, putInCheck, rebase, removeFolder, renameFolder, takeOut, takeOutId, takeOutProblem, type ArrangeNode, type ArrangeSite } from '../src/editor/client/arrange/model.ts';
import type { ListedFolders } from '../src/page-folders.ts';
import type { ListedDocument } from '../src/editor/types.ts';

const site: ArrangeSite = { collection: 'pages', base: '/', home: 'index', collections: [{ name: 'pages', label: 'Pages', urlBase: '/', nested: true, kind: 'sections' }] };
const page = (path: string, label: string) => ({ collection: 'pages', path, label, url: path === 'index' ? '/' : `/${path}`, file: `content/pages/${path}.json` }) as unknown as ListedDocument;
const base = ['index', 'about', 'about/team', 'contact', 'services/branding', 'services/websites', 'privacy'];
const labels: Record<string, string> = { index: 'Home', about: 'About', 'about/team': 'Team', contact: 'Contact', 'services/branding': 'Branding', 'services/websites': 'Websites', privacy: 'Privacy', 'company/story': 'Story', 'company/jobs': 'Jobs', company: 'Company' };
const docs = (paths: string[]) => paths.map((p) => page(p, labels[p] ?? p));
const open = (paths: string[], folders: ListedFolders = {}) => {
	const orig = buildTree(site, docs(paths), folders);
	return { orig, tree: structuredClone(orig) as ArrangeNode[] };
};
const lines = (plan: ReturnType<typeof makePlan>) => plan.folderLines.map((l) => l.parts.join(''));
const shape = (nodes: readonly ArrangeNode[]): string[] => nodes.flatMap((n) => [`${n.kind}:${n.id}${n.kind === 'folder' ? `(${n.fid}) ${n.label}` : ''}`, ...shape(n.kids).map((k) => `  ${k}`)]);
const company: ListedFolders = { '': [{ id: 'company', name: 'Company', rows: ['about', 'contact'] }] };

describe('page folders: the plan', () => {
	test('a new folder filled: no moves, the token in the order, its folder, no review entries', () => {
		const { orig, tree } = open(base);
		const fid = addFolder(tree, 'Company', 1, []);
		moveNode(tree, 'about', fid, null);
		moveNode(tree, 'contact', fid, null);
		const plan = makePlan(site, orig, tree);
		assert.deepEqual(plan.moves, []);
		assert.deepEqual(plan.order, { '': ['services', 'privacy', '(company)'] });
		assert.deepEqual(plan.folders, { '': [{ id: 'company', name: 'Company', pages: ['about', 'contact'] }] });
		assert.deepEqual(plan.entries, []);
		assert.equal(plan.orderOnly, true);
		assert.deepEqual(lines(plan), ['Company is a new folder', 'About and Contact go into Company']);
	});

	test('filing into an existing folder, and renaming it', () => {
		const { orig, tree } = open(base, company);
		moveNode(tree, 'privacy', 'folder:(company)', null);
		renameFolder(tree, 'folder:(company)', 'About us');
		const plan = makePlan(site, orig, tree);
		assert.deepEqual(plan.moves, []);
		assert.deepEqual(plan.order, { '': ['(company)', 'services'] });
		assert.deepEqual(plan.folders, { '': [{ id: 'company', name: 'About us', pages: ['about', 'contact', 'privacy'] }] });
		assert.deepEqual(lines(plan), ['Company is renamed About us', 'Privacy goes into About us']);
	});

	test('Remove: the rows go back in its place and order, the level\'s folders sent empty', () => {
		const { orig, tree } = open(base, company);
		removeFolder(tree, 'folder:(company)');
		const plan = makePlan(site, orig, tree);
		assert.deepEqual(plan.moves, []);
		assert.deepEqual(plan.order, { '': ['about', 'contact', 'services', 'privacy'] });
		assert.deepEqual(plan.folders, { '': [] });
		assert.deepEqual(lines(plan), ['Company is removed: About and Contact go back to the top level, in its place']);
	});

	test('Put in the addresses at a new part: every row moves under it, the group in the folder\'s place', () => {
		const { orig, tree } = open(base, company);
		const check = putInCheck(site, tree, 'folder:(company)', 'company');
		assert.equal(check.bad, false);
		assert.equal(check.info, 'Its 2 pages move under it, in this order: /company/about, /company/contact.');
		putIn(tree, 'folder:(company)', 'company');
		const plan = makePlan(site, orig, tree);
		assert.deepEqual(plan.moves, [
			{ collection: 'pages', fromPath: 'about', toPath: 'company/about' },
			{ collection: 'pages', fromPath: 'contact', toPath: 'company/contact' },
		]);
		assert.deepEqual(plan.order, { '': ['company', 'services', 'privacy'], company: ['about', 'contact'] });
		assert.deepEqual(plan.folders, { '': [] });
		assert.equal(plan.entries[0]!.t, 'putin');
		assert.deepEqual(lines(plan), []);
	});

	test('Put in\'s line says rows when a group is in the folder', () => {
		const { tree } = open(base, { '': [{ id: 'company', name: 'Company', rows: ['about', 'services'] }] });
		assert.equal(putInCheck(site, tree, 'folder:(company)', 'company').info, 'Its 2 rows move under it, in this order: /company/about, /company/services/.');
		const one = open(base, { '': [{ id: 'company', name: 'Company', rows: ['contact'] }] });
		assert.equal(putInCheck(site, one.tree, 'folder:(company)', 'company').info, 'Its page moves under it, in this order: /company/contact.');
	});

	test('Put in at a member\'s slug: that page takes the folder\'s place, the others go under it', () => {
		const { orig, tree } = open(base, { '': [{ id: 'about', name: 'About', rows: ['about', 'contact'] }] });
		putIn(tree, 'folder:(about)', 'about');
		const plan = makePlan(site, orig, tree);
		assert.deepEqual(plan.moves, [{ collection: 'pages', fromPath: 'contact', toPath: 'about/contact' }]);
		assert.deepEqual(plan.order, { '': ['about', 'services', 'privacy'], about: ['team', 'contact'] });
		assert.deepEqual(plan.folders, { '': [] });
		assert.equal(plan.entries[0]!.t, 'absorbed');
		assert.deepEqual(lines(plan), ['The About folder goes: About takes its place']);
	});

	test('Take out of the addresses: a folder in the group\'s place, a folder inside it dissolving, one line each', () => {
		const paths = [...base, 'company/story', 'company/jobs'];
		const { orig, tree } = open(paths, { company: [{ id: 'inner', name: 'Inner', rows: ['company/jobs'] }] });
		takeOut(tree, 'company', takeOutId(orig, tree, 'company', { '': [], company: ['inner'] }));
		const plan = makePlan(site, orig, tree);
		assert.deepEqual(plan.moves, [
			{ collection: 'pages', fromPath: 'company/story', toPath: 'story' },
			{ collection: 'pages', fromPath: 'company/jobs', toPath: 'jobs' },
		]);
		assert.deepEqual(plan.order, { '': ['about', 'contact', 'services', 'privacy', '(company)'] });
		assert.deepEqual(plan.folders, { '': [{ id: 'company', name: 'Company', pages: ['story', 'jobs'] }] });
		assert.equal(plan.entries[0]!.t, 'takeout');
		assert.deepEqual(lines(plan), ['Inner goes: its rows join Company in its place, since a folder can’t hold a folder']);
	});

	test('Take out of a group filed in a folder: its rows join the outer folder in its place, no new folder', () => {
		const paths = [...base, 'company/story', 'company/jobs'];
		const { orig, tree } = open(paths, { '': [{ id: 'main', name: 'Main', rows: ['about', 'company'] }], company: [{ id: 'inner', name: 'Inner', rows: ['company/jobs'] }] });
		takeOut(tree, 'company', 'company');
		const plan = makePlan(site, orig, tree);
		assert.deepEqual(plan.moves, [
			{ collection: 'pages', fromPath: 'company/story', toPath: 'story' },
			{ collection: 'pages', fromPath: 'company/jobs', toPath: 'jobs' },
		]);
		assert.deepEqual(plan.folders, { '': [{ id: 'main', name: 'Main', pages: ['about', 'story', 'jobs'] }] });
		assert.deepEqual(lines(plan), [
			'Inner goes: its rows join Main in its place, since a folder can’t hold a folder',
			'Company comes out of the addresses: its rows join Main in its place, since a folder can’t hold a folder',
		]);
	});

	test('a folder moved into Services takes its rows to that level, and keeps them', () => {
		const { orig, tree } = open(base, company);
		moveNode(tree, 'folder:(company)', 'services', null);
		const plan = makePlan(site, orig, tree);
		assert.deepEqual(plan.moves, [
			{ collection: 'pages', fromPath: 'about', toPath: 'services/about' },
			{ collection: 'pages', fromPath: 'contact', toPath: 'services/contact' },
		]);
		assert.deepEqual(plan.order, { '': ['services', 'privacy'], services: ['branding', 'websites', '(company)'] });
		assert.deepEqual(plan.folders, { '': [], services: [{ id: 'company', name: 'Company', pages: ['about', 'contact'] }] });
		assert.equal(plan.entries[0]!.t, 'fmove');
	});

	test('Put in then Take out on the screen gives the folder its own id back: nothing to apply', () => {
		const { orig, tree } = open(base, company);
		putIn(tree, 'folder:(company)', 'company');
		takeOut(tree, 'folder:(company)', takeOutId(orig, tree, 'folder:(company)', { '': ['company'] }));
		const plan = makePlan(site, orig, tree);
		assert.equal(tree.find((n) => n.id === 'folder:(company)')!.was, undefined);
		assert.equal(plan.any, false);
		assert.deepEqual(plan.order, {});
		assert.deepEqual(plan.folders, {});
	});

	test('a group taken out still steers clear of a hidden folder\'s id at its level', () => {
		const paths = [...base, 'company/story'];
		const { orig, tree } = open(paths);
		assert.equal(takeOutId(orig, tree, 'company', { '': ['company'] }), 'company-2');
	});
});

describe('page folders: re-planning on a fresh listing', () => {
	test('Take out of a group whose name is over 60 characters is refused at the row', () => {
		const long = 'a-very-long-group-name-that-goes-on-and-on-and-on-past-sixty-characters';
		const { tree } = open([...base, `${long}/x`]);
		const node = tree.find((n) => n.id === long)!;
		assert.deepEqual(takeOutProblem(site, tree, docs([...base, `${long}/x`]), long), { error: `Can’t take ${node.label} out of the addresses: a folder’s name can be at most 60 characters. Rename it first.` });
	});

	test('Take out stays taken out when the listing only changed the order', () => {
		const paths = [...base, 'company/story'];
		const { orig, tree } = open(paths);
		takeOut(tree, 'company', 'company');
		const r = rebase(site, orig, tree, docs(['index', 'privacy', ...paths.filter((p) => p !== 'index' && p !== 'privacy')]));
		const node = r.tree.find((n) => n.id === 'company')!;
		assert.equal(node.kind, 'folder');
		assert.equal(node.slug, '');
		const plan = makePlan(site, r.orig, r.tree);
		assert.deepEqual(plan.moves, [{ collection: 'pages', fromPath: 'company/story', toPath: 'story' }]);
		assert.ok(plan.order['']!.includes('(company)'));
		assert.ok(!plan.order['']!.includes(''));
		assert.deepEqual(plan.folders, { '': [{ id: 'company', name: 'Company', pages: ['story'] }] });
	});

	test('Put in stays put in', () => {
		const { orig, tree } = open(base, company);
		putIn(tree, 'folder:(company)', 'company');
		const r = rebase(site, orig, tree, docs(['index', 'services/branding', 'services/websites', 'privacy', 'about', 'about/team', 'contact']), company);
		const plan = makePlan(site, r.orig, r.tree);
		assert.deepEqual(plan.moves, [
			{ collection: 'pages', fromPath: 'about', toPath: 'company/about' },
			{ collection: 'pages', fromPath: 'contact', toPath: 'company/contact' },
		]);
		assert.deepEqual(plan.folders, { '': [] });
	});

	test('a kind the listing changed still follows the listing', () => {
		const paths = [...base, 'company/story'];
		const { orig, tree } = open(paths);
		takeOut(tree, 'company', 'company');
		const r = rebase(site, orig, tree, docs([...paths, 'company']));
		const node = r.tree.find((n) => n.id === 'company')!;
		assert.equal(node.kind, 'page');
		assert.equal(node.slug, 'company');
		assert.equal(node.fid, undefined);
	});

	test('a folder made since arrives with its rows filed in it, the untouched top level in the listing\'s order, and is sent back as it is', () => {
		const { orig, tree } = open(base);
		moveNode(tree, 'services/websites', 'services', 'services/branding');
		const r = rebase(site, orig, tree, docs(['index', 'services/branding', 'services/websites', 'privacy', 'about', 'about/team', 'contact']), company);
		assert.deepEqual(r.notes, ['The Company folder was added at the top level since you opened this, with About and Contact in it.']);
		assert.deepEqual(shape(r.tree).filter((l) => !l.startsWith('    ')), ['page:index', 'group:services', '  page:services/websites', '  page:services/branding', 'page:privacy', 'folder:folder:(company)(company) Company', '  page:about', '  page:contact']);
		// Scenario C: the person only reordered Services, so the top level isn't sent (the other's order stands).
		const plan = makePlan(site, r.orig, r.tree);
		assert.deepEqual(plan.order, { services: ['websites', 'branding'] });
		assert.deepEqual(plan.folders, {});
		assert.deepEqual(lines(plan), []);
	});

	test('a folder made since whose rows the person moved elsewhere goes, and says so', () => {
		const { orig, tree } = open(base);
		moveNode(tree, 'about', 'services', null);
		moveNode(tree, 'contact', 'services', null);
		const r = rebase(site, orig, tree, docs(base), company);
		assert.deepEqual(r.notes, ['The Company folder was added at the top level since you opened this, but you’ve arranged its rows elsewhere, so it goes.']);
		assert.equal(r.tree.some((n) => n.kind === 'folder'), false);
	});

	test('rows filed in, and taken out of, an existing folder since follow the listing', () => {
		const { orig, tree } = open(base, { '': [{ id: 'company', name: 'Company', rows: ['about', 'privacy'] }] });
		moveNode(tree, 'services/websites', 'services', 'services/branding');
		const r = rebase(site, orig, tree, docs(base), company);
		assert.deepEqual(r.notes, ['Contact was filed in Company since you opened this.', 'Privacy was taken out of Company since you opened this.']);
		const plan = makePlan(site, r.orig, r.tree);
		assert.equal(plan.folders[''], undefined);
		assert.deepEqual(plan.order, { services: ['websites', 'branding'] });
	});

	test('what the person filed stays filed', () => {
		const { orig, tree } = open(base, company);
		moveNode(tree, 'privacy', 'folder:(company)', null);
		const r = rebase(site, orig, tree, docs(base), { '': [{ id: 'company', name: 'Company', rows: ['about', 'contact'] }, { id: 'legal', name: 'Legal', rows: ['privacy'] }] });
		const plan = makePlan(site, r.orig, r.tree);
		assert.deepEqual(plan.folders[''], [{ id: 'company', name: 'Company', pages: ['about', 'contact', 'privacy'] }]);
	});

	test('a folder renamed since takes its new name, unless the person renamed it too', () => {
		const renamed: ListedFolders = { '': [{ id: 'company', name: 'About us', rows: ['about', 'contact'] }] };
		const a = open(base, company);
		const r1 = rebase(site, a.orig, a.tree, docs(base), renamed);
		assert.deepEqual(r1.notes, ['The Company folder was renamed About us since you opened this.']);
		assert.equal(makePlan(site, r1.orig, r1.tree).any, false);
		const b = open(base, company);
		renameFolder(b.tree, 'folder:(company)', 'Studio');
		const r2 = rebase(site, b.orig, b.tree, docs(base), renamed);
		assert.deepEqual(r2.notes, []);
		assert.deepEqual(makePlan(site, r2.orig, r2.tree).folders[''], [{ id: 'company', name: 'Studio', pages: ['about', 'contact'] }]);
	});

	test('a folder removed since dissolves in place, its rows staying', () => {
		const { orig, tree } = open(base, company);
		const r = rebase(site, orig, tree, docs(base));
		assert.deepEqual(r.notes, ['The Company folder was removed since you opened this; its rows stay where they are.']);
		assert.deepEqual(r.tree.map((n) => n.id), ['index', 'about', 'contact', 'services', 'privacy']);
		assert.equal(makePlan(site, r.orig, r.tree).any, false);
	});

	test('a level the person reordered keeps their order; one they didn\'t takes the listing\'s', () => {
		const { orig, tree } = open(base);
		moveNode(tree, 'privacy', null, 'about');
		moveNode(tree, 'services/websites', 'services', 'services/branding');
		// Since: someone else put Contact first at the top level.
		const later = docs(['index', 'contact', 'about', 'about/team', 'services/branding', 'services/websites', 'privacy']);
		const r = rebase(site, orig, tree, later);
		assert.deepEqual(r.tree.map((n) => n.id), ['index', 'privacy', 'about', 'contact', 'services']);
		const mine = open(base);
		moveNode(mine.tree, 'services/websites', 'services', 'services/branding');
		const r2 = rebase(site, mine.orig, mine.tree, later);
		assert.deepEqual(r2.tree.map((n) => n.id), ['index', 'contact', 'about', 'services', 'privacy']);
		assert.deepEqual(makePlan(site, r2.orig, r2.tree).order, { services: ['websites', 'branding'] });
	});

	test('a folder the person made whose id is hidden (not drawn) at its level since gets a free one', () => {
		const { orig, tree } = open(base);
		const fid = addFolder(tree, 'Company', 1, []);
		moveNode(tree, 'privacy', fid, null);
		const r = rebase(site, orig, tree, docs(base), {}, { '': ['company'] });
		assert.equal(r.tree.find((n) => n.id === fid)!.fid, 'company-2');
	});

	test('a folder the person made with a name another made since is a clash; with only its id taken it gets a free one', () => {
		const a = open(base);
		const fid = addFolder(a.tree, 'Company', 1, []);
		moveNode(a.tree, 'privacy', fid, null);
		const r1 = rebase(site, a.orig, a.tree, docs(base), company);
		assert.equal(r1.clashes.length, 1);
		assert.match(r1.clashes[0]!, /two folders called Company at the top level/);
		const b = open(base);
		const fid2 = addFolder(b.tree, 'Company', 1, []);
		moveNode(b.tree, 'privacy', fid2, null);
		const r2 = rebase(site, b.orig, b.tree, docs(base), { '': [{ id: 'company', name: 'Studio', rows: ['about', 'contact'] }] });
		assert.deepEqual(r2.clashes, []);
		assert.equal(r2.tree.find((n) => n.id === fid2)!.fid, 'company-2');
	});
});
