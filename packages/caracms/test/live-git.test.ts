// The git layer on the in-memory backend (M4 Decisions 5–8, 10; Phase 1 → Verify 1).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveSite, type SiteConfig } from '../src/config.ts';
import { listDocuments, readDocument } from '../src/content.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { generateKeyPairSync } from 'node:crypto';
import { GitHubClient, Tracker } from '../src/live/github.ts';
import { LiveGit } from '../src/live/git.ts';
import { parseMessage } from '../src/live/messages.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { siteFiles } from '../src/live/runtime.ts';
import { site as diskSite, siteRoot, variant } from './helpers/site.ts';

// The fixture site, as if it sat under starter/ in its repo (the demo's shape, Decision 3).
const site = resolveSite(variant({ repoPath: 'starter' } as Partial<SiteConfig>), siteRoot);
const aoife = { email: 'aoife@example.com', name: 'Aoife' };
const ciaran = { email: 'ciaran@example.com' };
const HOME = 'content/pages/index.json';
const ABOUT = 'content/pages/about.json';
const CONTACT = 'content/pages/contact.json';

async function setup() {
	const backend = new MemoryBackend(new Tracker());
	const files = await siteFiles(site);
	backend.seed([...files, { path: 'starter/src/Page.astro', contents: 'page\n' }, { path: 'README.md', contents: 'readme\n' }]);
	const git = new LiveGit({ backend, site, redis: memoryRedis(), log: () => {}, runningCommit: () => null });
	await git.start();
	return { backend, git };
}

const edit = (text: string, patch: (v: Record<string, unknown>) => void) => {
	const v = JSON.parse(text);
	patch(v);
	return `${JSON.stringify(v, null, 2)}\n`;
};
const creating = (b: MemoryBackend, from = 0) => b.tracker.records.slice(from).filter((r) => r.creating).length;

describe('the drafts copy', () => {
	test('start creates drafts from main and keeps only the site\'s content files', async () => {
		const { backend, git } = await setup();
		assert.equal(backend.refs.get('drafts'), backend.refs.get('main'));
		assert.ok(git.files().has(HOME));
		assert.ok(![...git.files().keys()].some((p) => p.startsWith('src/') || p === 'README.md'));
	});

	test('the reader gives the same documents from the copy as from disk', async () => {
		const { git } = await setup();
		const source = git.contentSource();
		assert.deepEqual(await listDocuments(site, undefined, source), await listDocuments(diskSite));
		assert.deepEqual(await readDocument(site, 'pages', 'about/team', source), await readDocument(diskSite, 'pages', 'about/team'));
		await assert.rejects(readDocument(site, 'pages', 'nope', source), /no document "nope"/);
	});
});

describe('draft commits', () => {
	test('a batch is one commit, with one Edited-by per editor (Decision 5)', async () => {
		const { backend, git } = await setup();
		const home = git.read(HOME)!;
		const about = git.read(ABOUT)!;
		const before = backend.tracker.records.length;
		const r = await git.commitDrafts([
			{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Home!')), editor: aoife },
			{ file: ABOUT, base: about, text: edit(about, (v) => (v.title = 'About!')), editor: aoife },
			{ file: ABOUT, base: about, text: edit(about, (v) => (v.title = 'About!!')), editor: ciaran },
		]);
		assert.equal(creating(backend, before), 1);
		assert.equal(backend.tracker.records.length - before, 1, 'drafts\' head comes from the copy: one request');
		const message = backend.info(r.commit!).message;
		assert.equal(
			message,
			'Draft: Home!, About!!\n\nEdited-by: Aoife <aoife@example.com>: content/pages/index.json, content/pages/about.json\nEdited-by: ciaran <ciaran@example.com>: content/pages/about.json',
		);
		assert.equal(JSON.parse(backend.file('drafts', `starter/${ABOUT}`)!).title, 'About!!');
		assert.equal(git.read(ABOUT), backend.file('drafts', `starter/${ABOUT}`));
		const waiting = git.waiting();
		assert.deepEqual(waiting.map((w) => w.file).sort(), [ABOUT, HOME]);
		assert.deepEqual(waiting.find((w) => w.file === ABOUT)!.editors.map((e) => e.person.email), ['ciaran@example.com', 'aoife@example.com']);
	});

	test('the commit the sweep makes is read back by parseMessage: editors, files relative to the site\'s folder, titles (Decision 5)', async () => {
		const { backend, git } = await setup();
		const home = git.read(HOME)!;
		const about = git.read(ABOUT)!;
		const r = await git.commitDrafts([
			{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Home!')), editor: aoife },
			{ file: ABOUT, base: about, text: edit(about, (v) => (v.title = 'About!')), editor: aoife },
			{ file: ABOUT, base: about, text: edit(about, (v) => (v.title = 'About!!')), editor: ciaran },
		]);
		const parsed = parseMessage(backend.info(r.commit!).message);
		assert.equal(parsed.kind, 'draft');
		assert.deepEqual(parsed.titles, ['Home!', 'About!!']);
		assert.deepEqual(parsed.edits, [
			{ person: aoife, files: [HOME, ABOUT] },
			{ person: { email: 'ciaran@example.com', name: null }, files: [ABOUT] },
		]);
		assert.ok(parsed.edits.every((e) => e.files.every((f) => !f.startsWith('starter/'))), 'the repo path (Decision 3) is not in the message');
		assert.deepEqual(parsed.keptDraft, []);
	});

	test('a conflict on the same key is a kept draft, and the commit says which file', async () => {
		const { backend, git } = await setup();
		const base = git.read(HOME)!;
		await git.commitDrafts([{ file: HOME, base, text: edit(base, (v) => (v.title = 'Theirs')), editor: ciaran }]);
		const r = await git.commitDrafts([{ file: HOME, base, text: edit(base, (v) => (v.title = 'Mine')), editor: aoife }]);
		assert.deepEqual(r.keptDraft, [HOME]);
		assert.equal(JSON.parse(git.read(HOME)!).title, 'Mine');
		assert.deepEqual(parseMessage(backend.info(r.commit!).message).keptDraft, [HOME]);
		assert.equal(git.waiting().find((w) => w.file === HOME)!.keptDraft, true);
	});

	test('an autosave whose base is stale merges with drafts instead of overwriting (Decision 6)', async () => {
		const { git } = await setup();
		const base = git.read(HOME)!;
		await git.commitDrafts([{ file: HOME, base, text: edit(base, (v) => (v.seo = { a: 1 })), editor: ciaran }]);
		const r = await git.commitDrafts([{ file: HOME, base, text: edit(base, (v) => (v.title = 'Mine')), editor: aoife }]);
		const v = JSON.parse(git.read(HOME)!);
		assert.equal(v.title, 'Mine');
		assert.deepEqual(v.seo, { a: 1 });
		assert.deepEqual(r.keptDraft, []);
	});

	test("an edit, then an undo back to main's text: not waiting any more, and matchesMain says so (a client site's port)", async () => {
		const { git } = await setup();
		const home = git.read(HOME)!;
		const changed = edit(home, (v) => (v.title = 'Home!'));
		await git.commitDrafts([{ file: HOME, base: home, text: changed, editor: aoife }]);
		assert.deepEqual(git.waiting().map((w) => w.file), [HOME]);
		assert.equal(git.matchesMain(HOME, changed), false);
		assert.equal(git.matchesMain(HOME, home), true, "an autosave of main's text isn't waiting");
		// The undo reaches drafts: back to main's text.
		await git.commitDrafts([{ file: HOME, base: changed, text: home, editor: aoife }]);
		assert.deepEqual(git.waiting(), []);
		assert.equal(git.matchesMain(HOME, home), true);
		// And a new edit after it is waiting again.
		await git.commitDrafts([{ file: HOME, base: home, text: changed, editor: aoife }]);
		assert.deepEqual(git.waiting().map((w) => w.file), [HOME]);
	});

	test("a deletion undone by this server's commits isn't waiting; a file neither side has matches main", async () => {
		const { git } = await setup();
		const about = git.read(ABOUT)!;
		await git.commitDrafts([{ file: ABOUT, base: about, text: null, editor: aoife }]);
		assert.deepEqual(git.waiting().map((w) => [w.file, w.change]), [[ABOUT, 'deleted']]);
		await git.commitDrafts([{ file: ABOUT, base: null, text: about, editor: aoife }]);
		assert.deepEqual(git.waiting(), []);
		assert.equal(git.matchesMain('content/pages/never.json', null), true, "a file neither side has: drafts' null is main's");
	});

	test('nothing changed: no commit', async () => {
		const { backend, git } = await setup();
		const before = backend.tracker.records.length;
		const r = await git.commitDrafts([{ file: HOME, base: git.read(HOME), text: git.read(HOME)!, editor: aoife }]);
		assert.equal(r.commit, null);
		assert.equal(backend.tracker.records.length, before);
	});

	test('a lost race on drafts: the copy is refreshed and the batch merged again', async () => {
		const { backend, git } = await setup();
		const home = git.read(HOME)!;
		backend.beforeRequest = (endpoint) => {
			if (endpoint !== 'graphql createCommitOnBranch') return;
			backend.beforeRequest = null;
			// Another server's sweep lands first, on another key of the same file.
			backend.push('drafts', { [`starter/${HOME}`]: edit(home, (v) => (v.other = 'theirs')) }, 'Draft: Home\n\nEdited-by: ciaran <ciaran@example.com>: content/pages/index.json');
		};
		const r = await git.commitDrafts([{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Mine')), editor: aoife }]);
		assert.equal(r.attempts, 2);
		const v = JSON.parse(backend.file('drafts', `starter/${HOME}`)!);
		assert.deepEqual([v.title, v.other], ['Mine', 'theirs']);
		assert.equal(git.head().commit, backend.refs.get('drafts'));
		assert.deepEqual(git.waiting().find((w) => w.file === HOME)!.editors.map((e) => e.person.email), ['aoife@example.com', 'ciaran@example.com']);
	});
});

describe('keeping drafts up to date with main (Decision 8)', () => {
	test('drafts only behind: a fast-forward, no merge commit', async () => {
		const { backend, git } = await setup();
		const pushed = backend.push('main', { 'starter/src/Page.astro': 'page v2\n', [`starter/${CONTACT}`]: edit(git.read(CONTACT)!, (v) => (v.title = 'Get in touch')) });
		const r = await git.check({ force: true });
		assert.equal(r.kind, 'fast-forward');
		assert.equal(backend.refs.get('drafts'), pushed);
		assert.equal(JSON.parse(git.read(CONTACT)!).title, 'Get in touch');
		assert.deepEqual(git.waiting(), []);
	});

	test('diverged: pending autosaves first, then a per-key merge; deletions on each side', async () => {
		const { backend, git } = await setup();
		let pending = 0;
		git.commitPending = async () => {
			pending++;
		};
		const home = git.read(HOME)!;
		const about = git.read(ABOUT)!;
		const work = git.read('content/pages/work.json')!;
		// The editor: Home's title, About's title; deletes Work (as a push to drafts would).
		await git.commitDrafts([
			{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Draft home')), editor: aoife },
			{ file: ABOUT, base: about, text: edit(about, (v) => (v.title = 'Draft about')), editor: aoife },
		]);
		backend.push('drafts', { [`starter/content/pages/work.json`]: null }, 'Remove Work');
		// A developer: Home's seo (another key), About's title (the same key), Contact (only main),
		// deletes Untitled (only main), and code.
		backend.push('main', {
			[`starter/${HOME}`]: edit(home, (v) => (v.seo = { description: 'From main' })),
			[`starter/${ABOUT}`]: edit(about, (v) => (v.title = 'Main about')),
			[`starter/${CONTACT}`]: edit(git.read(CONTACT)!, (v) => (v.title = 'Main contact')),
			'starter/content/pages/untitled.json': null,
			'starter/src/Page.astro': 'page v2\n',
		});
		assert.ok(work);
		const r = await git.check({ force: true });
		assert.equal(pending, 1, 'pending autosaves are committed before the merge');
		assert.equal(r.kind, 'merged');
		if (r.kind !== 'merged') return;
		assert.deepEqual(r.keptDraft, [ABOUT]);
		const at = (p: string) => backend.file('drafts', `starter/${p}`);
		assert.deepEqual([JSON.parse(at(HOME)!).title, JSON.parse(at(HOME)!).seo], ['Draft home', { description: 'From main' }]);
		assert.equal(JSON.parse(at(ABOUT)!).title, 'Draft about');
		assert.equal(JSON.parse(at(CONTACT)!).title, 'Main contact');
		assert.equal(at('content/pages/untitled.json'), null, 'deleted on main');
		assert.equal(at('content/pages/work.json'), null, 'deleted on drafts');
		assert.equal(backend.file('drafts', 'starter/src/Page.astro'), 'page v2\n');
		const merge = backend.info(backend.refs.get('drafts')!);
		assert.deepEqual(merge.parents.length, 2);
		assert.deepEqual(parseMessage(merge.message).keptDraft, [ABOUT]);
		// The copy matches drafts exactly, and the notice data is in the waiting list.
		for (const [file, text] of git.files()) assert.equal(text, at(file), file);
		assert.equal(git.read('content/pages/untitled.json'), null);
		assert.equal(git.waiting().find((w) => w.file === ABOUT)!.keptDraft, true);
		assert.equal(git.waiting().find((w) => w.file === HOME)!.keptDraft, false);
		// main is now in drafts: a second check is a no-op.
		assert.equal((await git.check({ force: true })).kind, 'current');
	});

	test('the check is throttled to once a minute unless forced', async () => {
		let t = 1_000_000;
		const backend = new MemoryBackend(new Tracker());
		backend.seed(await siteFiles(site));
		const git = new LiveGit({ backend, site, redis: memoryRedis(), now: () => t, log: () => {}, runningCommit: () => null });
		await git.start();
		const before = backend.tracker.records.length;
		await git.check();
		assert.equal(backend.tracker.records.length, before);
		t += 61_000;
		await git.check();
		assert.equal(backend.tracker.records.length, before + 1, 'one cheap ref read');
	});
});

describe('Publish (Decision 10)', () => {
	test('one squashed commit on main with drafts\' tree; both refs on it', async () => {
		const { backend, git } = await setup();
		let pending = 0;
		git.commitPending = async () => {
			pending++;
		};
		const home = git.read(HOME)!;
		await git.commitDrafts([{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Published home')), editor: aoife }]);
		const mainBefore = backend.refs.get('main')!;
		const r = await git.publish(ciaran);
		assert.equal(pending, 1);
		assert.equal(r.kind, 'published');
		if (r.kind !== 'published') return;
		const commit = backend.info(r.record.commit);
		assert.deepEqual(commit.parents, [mainBefore]);
		assert.equal(commit.message.split('\n')[0], 'Published: Published home — by ciaran');
		assert.equal(backend.refs.get('main'), r.record.commit);
		assert.equal(backend.refs.get('drafts'), r.record.commit);
		assert.deepEqual(r.record.files, [HOME]);
		assert.deepEqual(git.waiting(), []);
		assert.deepEqual((await git.lastPublish())!.commit, r.record.commit);
	});

	test('nothing waiting: no commit, no ref move', async () => {
		const { backend, git } = await setup();
		const before = backend.tracker.records.length;
		const main = backend.refs.get('main');
		assert.equal((await git.publish(aoife)).kind, 'nothing-waiting');
		assert.equal(creating(backend, before), 0);
		assert.equal(backend.refs.get('main'), main);
	});

	for (const side of ['drafts', 'main'] as const) {
		test(`a lost race on ${side}: retried, and nothing orphaned on main`, async () => {
			const { backend, git } = await setup();
			const home = git.read(HOME)!;
			const contact = git.read(CONTACT)!;
			await git.commitDrafts([{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Mine')), editor: aoife }]);
			backend.beforeRequest = (endpoint) => {
				if (endpoint !== 'graphql updateRefs') return;
				backend.beforeRequest = null;
				// A sweep on another server, or a developer's push, lands mid-Publish.
				if (side === 'drafts') backend.push('drafts', { [`starter/${CONTACT}`]: edit(contact, (v) => (v.title = 'Late draft')) }, 'Draft: Late\n\nEdited-by: ciaran <ciaran@example.com>: content/pages/contact.json');
				else backend.push('main', { 'starter/src/Page.astro': 'pushed mid-publish\n' });
			};
			const r = await git.publish(aoife);
			assert.equal(r.kind, 'published');
			if (r.kind !== 'published') return;
			// drafts: lost, then won. main: lost, merged main into drafts, then won.
			assert.equal(r.attempts, side === 'drafts' ? 2 : 3);
			assert.equal(backend.refs.get('main'), r.record.commit);
			assert.equal(backend.refs.get('drafts'), r.record.commit);
			const onMain = backend.reachable('main');
			const squashes = [...onMain].filter((c) => backend.info(c).message.startsWith('Published:'));
			assert.equal(squashes.length, 1, 'only the winning squash commit is on main');
			assert.equal(JSON.parse(backend.file('main', `starter/${HOME}`)!).title, 'Mine');
			if (side === 'drafts') assert.equal(JSON.parse(backend.file('main', `starter/${CONTACT}`)!).title, 'Late draft');
			else assert.equal(backend.file('main', 'starter/src/Page.astro'), 'pushed mid-publish\n');
		});
	}

	test('updateRefs landed but its answer was lost: published, with publish:last written, no second squash', async () => {
		const { backend, git } = await setup();
		const home = git.read(HOME)!;
		await git.commitDrafts([{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Mine')), editor: aoife }]);
		const original = backend.updateRefs.bind(backend);
		let lost = 0;
		backend.updateRefs = async (updates) => {
			await original(updates);
			if (lost++ === 0) throw new Error('fetch failed (the answer never came back)');
		};
		const r = await git.publish(aoife);
		assert.equal(r.kind, 'published');
		if (r.kind !== 'published') return;
		assert.equal(r.attempts, 1, 'not retried: the move had landed');
		assert.equal(backend.refs.get('main'), r.record.commit);
		assert.equal(backend.refs.get('drafts'), r.record.commit);
		assert.equal((await git.lastPublish())?.commit, r.record.commit, 'publish:last names it');
		const squashes = [...backend.reachable('main')].filter((c) => backend.info(c).message.startsWith('Published:'));
		assert.equal(squashes.length, 1);
	});

	test('a failure that moved neither ref is thrown, the publish lock is released, and a later press publishes', async () => {
		const { backend, git } = await setup();
		const home = git.read(HOME)!;
		await git.commitDrafts([{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Mine')), editor: aoife }]);
		const original = backend.updateRefs.bind(backend);
		let fail = true;
		backend.updateRefs = async (updates) => {
			if (fail) throw new Error('GitHub had a bad moment (502)');
			return original(updates);
		};
		const mainBefore = backend.refs.get('main');
		await assert.rejects(git.publish(aoife), /bad moment/);
		assert.equal(backend.refs.get('main'), mainBefore, 'main did not move');
		assert.equal(await git.lastPublish(), null, 'nothing is recorded as published');
		fail = false;
		const again = await git.publish(aoife);
		assert.equal(again.kind, 'published', 'the lock was not left behind');
		const squashes = [...backend.reachable('main')].filter((c) => backend.info(c).message.startsWith('Published:'));
		assert.equal(squashes.length, 1);
	});

	test('a push to main before the press (no race): Publish merges it into drafts first, and publishes both', async () => {
		const { backend, git } = await setup();
		const home = git.read(HOME)!;
		await git.commitDrafts([{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Mine')), editor: aoife }]);
		const pushed = backend.push('main', { [`starter/${CONTACT}`]: edit(git.read(CONTACT)!, (v) => (v.title = 'Main contact')) });
		const r = await git.publish(aoife);
		assert.equal(r.kind, 'published');
		if (r.kind !== 'published') return;
		const squash = backend.info(r.record.commit);
		assert.deepEqual(squash.parents, [pushed], 'the squash sits on main\'s newest head');
		assert.equal(JSON.parse(backend.file('main', `starter/${HOME}`)!).title, 'Mine');
		assert.equal(JSON.parse(backend.file('main', `starter/${CONTACT}`)!).title, 'Main contact');
		assert.equal(backend.refs.get('drafts'), r.record.commit);
		assert.deepEqual(r.record.files, [HOME], 'what was published is the draft\'s change, not the developer\'s');
	});

	test('a second press while one runs joins it', async () => {
		const { git } = await setup();
		const home = git.read(HOME)!;
		await git.commitDrafts([{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Mine')), editor: aoife }]);
		let release!: () => void;
		git.commitPending = () => new Promise<void>((r) => (release = r));
		const first = git.publish(aoife);
		await new Promise((r) => setTimeout(r, 5));
		const second = git.publish(ciaran);
		release();
		const [a, b] = await Promise.all([first, second]);
		assert.equal(a.kind, 'published');
		assert.equal(b.kind, 'joined');
		if (a.kind === 'published' && b.kind === 'joined') assert.equal(b.record!.commit, a.record.commit);
	});
});

describe('GitHub requests time out (no request waits forever)', () => {
	const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
	/** A GitHub that signs the App in, then never answers anything else (until the request's signal aborts it). */
	const stalling = (async (url: string | URL, init: RequestInit = {}) => {
		const path = new URL(String(url)).pathname;
		if (path.endsWith('/installation')) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
		if (path.endsWith('/access_tokens')) return new Response(JSON.stringify({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 });
		return new Promise<Response>((_, reject) => {
			if (!init.signal) return; // no timeout: it hangs for good
			init.signal.addEventListener('abort', () => reject(init.signal!.reason));
		});
	}) as typeof fetch;
	const client = () => new GitHubClient({ appId: '1', privateKey, owner: 'o', repo: 'r', fetch: stalling, timeoutMs: 50 }, new Tracker());
	const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms))]);

	test('rest, graphql and bytes each fail after the timeout', async () => {
		const gh = client();
		await assert.rejects(within(gh.rest('GET', '/repos/o/r/git/ref/heads/main'), 2000), /timeout|aborted/i);
		await assert.rejects(within(gh.graphql('query { viewer { login } }', {}, 'viewer'), 2000), /timeout|aborted/i);
		await assert.rejects(within(gh.bytes('/repos/o/r/tarball/main'), 2000), /timeout|aborted/i);
	});
});
