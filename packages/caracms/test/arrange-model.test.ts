// Arrange pages: the screen's model. The tree from the
// listing, the Apply's request (roots only, the order of each level that changed), the
// review's list, the drop and name checks, and re-planning on a fresh listing (Decision 10).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addGroup, buildTree, checkDrop, dropNode, makePlan, moveNode, nameCheck, rebase, renameGroup, type ArrangeNode, type ArrangeSite, type DropTarget } from '../src/editor/client/arrange/model.ts';
import type { ListedDocument } from '../src/editor/types.ts';

const site: ArrangeSite = {
	collection: 'pages',
	base: '/',
	home: 'index',
	collections: [
		{ name: 'pages', label: 'Pages', urlBase: '/', nested: true, kind: 'sections' },
		{ name: 'journal', label: 'Journal', urlBase: '/journal/', kind: 'sections', heldBy: 'pages', holder: { collection: 'pages', path: 'journal' } },
	],
};
const page = (path: string, label: string, extra: Partial<ListedDocument> = {}) => ({ collection: 'pages', path, label, url: path === 'index' ? '/' : `/${path}`, file: `content/pages/${path}.json`, ...extra }) as unknown as ListedDocument;
const post = (path: string) => ({ collection: 'journal', path, label: path, url: `/journal/${path}`, file: `content/journal/${path}.json` }) as unknown as ListedDocument;

// The starter's tree in the rule's order (Decision 7).
const listing = (): ListedDocument[] => [
	page('index', 'Home'),
	page('about', 'About'),
	page('about/team', 'Team'),
	page('journal', 'Journal', { holds: 'journal' }),
	page('services/branding', 'Branding'),
	page('services/websites', 'Websites'),
	page('studio/visit', 'Visit'),
	page('contact', 'Contact'),
	page('field-notes', 'Field notes', { hidden: true, hiddenSelf: true }),
	page('privacy', 'Privacy'),
	page('faq', 'Questions'),
	post('a-day-on-the-ferry'),
	post('proofing-by-hand'),
];
const fresh = () => {
	const orig = buildTree(site, listing());
	return { orig, tree: structuredClone(orig) as ArrangeNode[] };
};
const ids = (nodes: ArrangeNode[]): string[] => nodes.flatMap((n) => [n.id, ...ids(n.kids).map((k) => `  ${k}`)]);
const land = (t: DropTarget) => {
	assert.notEqual(t.kind, 'refused', t.kind === 'refused' ? t.reason : '');
	return t as Exclude<DropTarget, { kind: 'refused' }>;
};

describe('the arrange model', () => {
	test('the tree keeps the listing\'s order, groups before their first page, the held collection on its page', () => {
		const { orig } = fresh();
		assert.deepEqual(orig.map((n) => `${n.kind}:${n.id}`), ['page:index', 'page:about', 'page:journal', 'group:services', 'group:studio', 'page:contact', 'page:field-notes', 'page:privacy', 'page:faq']);
		const journal = orig.find((n) => n.id === 'journal')!;
		assert.equal(journal.holds?.docs.length, 2);
		assert.equal(journal.holds?.many, 'journal entries');
		assert.equal(orig.find((n) => n.id === 'field-notes')!.hidden, true);
		assert.equal(orig.find((n) => n.id === 'services')!.label, 'Services');
	});

	test('an order-only arrangement: one level\'s full list, no moves, no tick', () => {
		const { orig, tree } = fresh();
		moveNode(tree, 'journal', null, 'about');
		const plan = makePlan(site, orig, tree);
		assert.deepEqual(plan.moves, []);
		assert.deepEqual(plan.order, { '': ['journal', 'about', 'services', 'studio', 'contact', 'field-notes', 'privacy', 'faq'] });
		assert.equal(plan.orderOnly, true);
		assert.equal(plan.live, false);
		assert.deepEqual(plan.reorders, [null]);
	});

	test('a new group filled, a group renamed: roots only, every address in the review', () => {
		const { orig, tree } = fresh();
		const company = addGroup(tree, 'Company', 1);
		moveNode(tree, 'about', company, null);
		moveNode(tree, 'contact', company, null);
		renameGroup(tree, 'services', 'Offerings', null);
		const plan = makePlan(site, orig, tree);
		assert.deepEqual(plan.moves, [
			{ collection: 'pages', fromPath: 'services/branding', toPath: 'offerings/branding' },
			{ collection: 'pages', fromPath: 'services/websites', toPath: 'offerings/websites' },
			{ collection: 'pages', fromPath: 'about', toPath: 'company/about' },
			{ collection: 'pages', fromPath: 'contact', toPath: 'company/contact' },
		]);
		assert.deepEqual(plan.order[''], ['journal', 'offerings', 'studio', 'field-notes', 'privacy', 'faq', 'company']);
		assert.deepEqual(plan.order.company, ['about', 'contact']);
		const lines = plan.entries.map((e) => ('from' in e && 'to' in e && e.t !== 'rename' && e.t !== 'groupmove' ? `${e.t} ${e.from} → ${e.to}` : e.t));
		assert.ok(lines.includes('carried /about/team → /company/about/team'), lines.join('\n'));
		assert.ok(lines.includes('move /contact → /company/contact'));
		assert.ok(lines.includes('carried /services/branding → /offerings/branding'));
		assert.equal(plan.live, true);
		assert.equal(plan.lead, '5 pages');
	});

	test('a page moved out from under a page that also moves is its own root', () => {
		const { orig, tree } = fresh();
		const company = addGroup(tree, 'Company', 1);
		moveNode(tree, 'about', company, null);
		moveNode(tree, 'about/team', 'contact', null);
		const plan = makePlan(site, orig, tree);
		assert.deepEqual(plan.moves.map((m) => `${m.fromPath} → ${m.toPath}`), ['about/team → contact/team', 'about → company/about']);
		assert.deepEqual(plan.order['company/about'], []);
		assert.deepEqual(plan.order.contact, ['team']);
	});

	test('the last page out of a group: the group goes, and the review says so', () => {
		const { orig, tree } = fresh();
		moveNode(tree, 'studio/visit', null, 'field-notes');
		const plan = makePlan(site, orig, tree);
		assert.ok(plan.entries.some((e) => e.t === 'gone' && e.label === 'Studio'));
		assert.equal(plan.order.studio, undefined, 'a group that goes has no key');
		assert.ok(!plan.order['']!.includes('studio'), 'nor a place in its level');
		assert.ok(plan.changes.some((c) => c.parts.join('') === 'Studio goes: no pages left in it'));
	});

	test('a holder moves with its documents as one count line; into a hidden page it will be hidden', () => {
		const { orig, tree } = fresh();
		moveNode(tree, 'journal', 'field-notes', null);
		const plan = makePlan(site, orig, tree);
		const held = plan.entries.find((e) => e.t === 'held');
		assert.ok(held && held.t === 'held' && held.held.docs.length === 2 && held.to === '/field-notes/journal/…');
		const move = plan.entries.find((e) => e.t === 'move');
		assert.equal(move?.t === 'move' ? move.vis : null, 'hidden');
		assert.equal(plan.lead, '1 page and 2 journal entries');
	});

	test('the tick is off when no changed address was ever live', () => {
		const { orig, tree } = fresh();
		moveNode(tree, 'privacy', 'about', null);
		assert.equal(makePlan(site, orig, tree, { pending: (_c, path) => path === 'privacy' }).live, false);
		assert.equal(makePlan(site, orig, tree).live, true);
	});

	test('drops: Home takes nothing, a page beside a page with its slug is refused, a page beside a group with its slug joins it', () => {
		const docs = [...listing(), page('studio/team', 'Team')];
		const orig = buildTree(site, docs);
		const tree = structuredClone(orig) as ArrangeNode[];
		const home = checkDrop(site, tree, docs, 'privacy', { kind: 'inside', parentId: 'index', beforeId: null, rowId: 'index', depth: 1 });
		assert.deepEqual(home, { kind: 'refused', rowId: 'index', reason: 'Home takes no pages' });
		const team = checkDrop(site, tree, docs, 'studio/team', { kind: 'inside', parentId: 'about', beforeId: null, rowId: 'about', depth: 1 });
		assert.equal(team.kind === 'refused' && team.reason, 'There’s already a page called Team here');
		// A page called "services" from elsewhere, dropped at the top level: it becomes Services' own page.
		const docs2 = [...listing(), page('about/services', 'Services')];
		const o2 = buildTree(site, docs2);
		const t2 = structuredClone(o2) as ArrangeNode[];
		const t = land(checkDrop(site, t2, docs2, 'about/services', { kind: 'beside', parentId: null, beforeId: 'contact', rowId: 'contact', edge: 'top', depth: 0 }));
		assert.equal(t.merge, 'services');
		dropNode(t2, 'about/services', t);
		assert.deepEqual(ids(t2).filter((x) => x.includes('services') || x.includes('branding')), ['about/services', '  services/branding', '  services/websites']);
		const plan = makePlan(site, o2, t2);
		assert.deepEqual(plan.moves, [{ collection: 'pages', fromPath: 'about/services', toPath: 'services' }]);
		assert.ok(plan.entries.some((e) => e.t === 'joined' && e.label === 'Services'));
	});

	test('names: the new-page rules, a sibling group refused, a sibling page joined', () => {
		const { tree } = fresh();
		assert.equal(nameCheck(site, tree, 'Studio', null, null).err, 'There’s already a group called Studio here.');
		assert.equal(nameCheck(site, tree, 'About', null, null).merge, 'about');
		assert.equal(nameCheck(site, tree, '***', null, null).err, 'That name has no letters or numbers to make an address from.');
		assert.equal(nameCheck(site, tree, 'Admin', null, null).bad, true);
		assert.deepEqual(nameCheck(site, tree, 'Pots & Pans etc.', null, null), { slug: 'pots-and-pans-etc', bad: false });
	});

	test('re-planned on a fresh listing: a page added under a renamed group, a new post, a deleted page', () => {
		const { orig, tree } = fresh();
		renameGroup(tree, 'services', 'Offerings', null);
		moveNode(tree, 'journal', 'about', null);
		moveNode(tree, 'privacy', 'contact', null);
		const later = [...listing().filter((d) => d.path !== 'privacy'), page('services/pots-and-pans-etc', 'Pots & Pans etc.'), post('the-new-letterpress')];
		const r = rebase(site, orig, tree, later);
		assert.deepEqual(r.added, ['services/pots-and-pans-etc']);
		assert.deepEqual(r.addedDocs, ['the-new-letterpress']);
		assert.ok(r.notes.includes('Pots & Pans etc. was added under Offerings since you opened this.'), r.notes.join('\n'));
		assert.ok(r.notes.includes('Privacy was deleted since you opened this.'));
		assert.ok(r.notes.some((n) => n.startsWith('Journal has a new journal entry since you opened this, so 3 journal entries move')), r.notes.join('\n'));
		assert.deepEqual(r.clashes, []);
		const plan = makePlan(site, r.orig, r.tree);
		assert.ok(plan.moves.some((m) => m.fromPath === 'services/pots-and-pans-etc' && m.toPath === 'offerings/pots-and-pans-etc'));
	});

	test('re-planned: a page made where a moved page would land is a clash', () => {
		const { orig, tree } = fresh();
		const company = addGroup(tree, 'Company', 1);
		moveNode(tree, 'about', company, null);
		const r = rebase(site, orig, tree, [...listing(), page('company/about', 'About us')]);
		assert.equal(r.clashes.length, 1, r.clashes.join('\n'));
		assert.match(r.clashes[0]!, /About us was added at \/company\/about, where About would go/);
	});

	test('a page hidden itself, under a hidden page: out of it, it stays hidden (the listing\'s own flag, not hiddenBy)', () => {
		// As the listing gives them (content.ts): Privacy hidden, Questions under it hidden itself too.
		const docs = [...listing().filter((d) => d.path !== 'faq' && d.path !== 'privacy'), page('privacy', 'Privacy', { hidden: true, hiddenSelf: true }), page('privacy/faq', 'Questions', { hidden: true, hiddenSelf: true, hiddenBy: 'privacy' })];
		const orig = buildTree(site, docs);
		const tree = structuredClone(orig) as ArrangeNode[];
		moveNode(tree, 'privacy/faq', null, null);
		const plan = makePlan(site, orig, tree);
		const move = plan.entries.find((e) => e.t === 'move' && e.id === 'privacy/faq');
		assert.equal(move?.t === 'move' ? move.vis : 'missing', null, 'neither "will be shown" nor "will be hidden"');
		assert.ok(!plan.changes.some((c) => c.parts.join('').includes('will be shown')));
		// One hidden only by the page above it is shown once it's out.
		const under = [...docs.filter((d) => d.path !== 'privacy/faq'), page('privacy/faq', 'Questions', { hidden: true, hiddenBy: 'privacy' })];
		const o2 = buildTree(site, under);
		const t2 = structuredClone(o2) as ArrangeNode[];
		moveNode(t2, 'privacy/faq', null, null);
		const m2 = makePlan(site, o2, t2).entries.find((e) => e.t === 'move');
		assert.equal(m2?.t === 'move' ? m2.vis : null, 'shown');
	});

	test('a group holding only groups that go goes too; a new one is empty (Review… off) and sends no level', () => {
		const { orig, tree } = fresh();
		const company = addGroup(tree, 'Company', 1);
		moveNode(tree, 'studio', company, null);
		moveNode(tree, 'studio/visit', null, 'contact');
		const plan = makePlan(site, orig, tree);
		assert.deepEqual(plan.emptyFresh.map((n) => n.id), [company], 'Company is empty: nothing under it but Studio, which goes');
		assert.ok(plan.gone.includes('studio'));
		assert.equal(plan.order.company, undefined, 'no key for it');
		assert.ok(!plan.order['']!.includes('company'), 'nor a place in its level');
		assert.ok(plan.entries.some((e) => e.t === 'newgroup' && e.empty));
		// An existing group whose only contents go goes with them: Services holding Studio, both emptied.
		const b = fresh();
		moveNode(b.tree, 'studio', 'services', null);
		moveNode(b.tree, 'studio/visit', null, 'contact');
		moveNode(b.tree, 'services/branding', null, 'contact');
		moveNode(b.tree, 'services/websites', null, 'contact');
		const p2 = makePlan(site, b.orig, b.tree);
		assert.deepEqual([...p2.gone].sort(), ['services', 'studio']);
		assert.equal(p2.order.services, undefined);
		assert.ok(!p2.order['']!.includes('services'));
		assert.deepEqual(p2.emptyFresh, []);
	});
});
