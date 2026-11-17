// A cloud site's repo renamed or transferred on GitHub while its server runs (caracms-cloud
// adversarial review, finding 7, which retires M2 Decision 13's refusal). The cloud learns the
// new name on the next token and answers with it; once its settings name it too, the server
// carries on under it, with no restart. The real runtime, GitHub client and backend, on
// CaraCMS Cloud and GitHub faked through the injected fetch: GitHub's API is answered by the
// in-memory GitHub (helpers/github-http.ts), which refuses anything still asking under the old
// name. A fake clock; the sweep's timer is driven by hand.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { resolveSite, type SiteConfig } from '../src/config.ts';
import type { SiteDocument } from '../src/document.ts';
import type { OpenedDocument, StatusResponse } from '../src/editor/types.ts';
import { GitHubBackend, MemoryBackend, type Branch } from '../src/live/backend.ts';
import { CLOUD_REPO_CHANGED, heldCloudSettings, loadCloudSettings, resetCloudSettings } from '../src/live/cloud.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import type { Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis, type MemoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { githubOverMemory, type GitHubOverMemory } from './helpers/github-http.ts';
import { siteRoot, variant } from './helpers/site.ts';

const site = resolveSite(variant({ repoPath: 'starter' } as Partial<SiteConfig>), siteRoot);
const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const HOME = 'content/pages/index.json';
const ORIGIN = 'http://site.test';
const KEY = `cck_${'A1b2C3d4E5'.repeat(4)}xY_`;
const CLOUD = 'https://cloud.test';
const OLD = 'example-org/site-a';
const NEW = 'example-org/website';
const SEC = 1000;
const MIN = 60 * SEC;
const RENAMED_TITLE = "This site's repo has a new name";
const renamedMessage = (repo: string, was: string) => `This site's GitHub repo is now ${repo} (it was ${was}). Changes save and publish to it as before; nothing needs doing.`;

const base: Omit<LiveSettings, 'github'> = {
	redisUrl: null,
	secret: 's'.repeat(32),
	allow: [],
	webhookSecret: null,
	railway: null,
	backup: null,
	runningCommit: null,
	timings: { ...DEFAULT_TIMINGS },
	production: false,
};

interface World {
	clock: { t: number };
	memory: MemoryBackend;
	redis: MemoryRedis;
	logs: string[];
	/** The repo's name on GitHub, which the cloud's next token answer names. */
	github: { name: string };
	/** What `GET /v1/settings` names: a repo, or `down` (the read fails). */
	settings: { repo: string | 'down' };
	/** The tokens the cloud has minted, newest last: GitHub takes only the newest. */
	tokens: string[];
	/** Every call to the cloud, in order. */
	cloud: string[];
	api: GitHubOverMemory;
	fetch: typeof fetch;
}

function world(token: string | null = null): World {
	const clock = { t: Date.parse('2026-10-27T10:00:00Z') };
	const memory = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
	const w = { clock, memory, redis: memoryRedis({ now: () => clock.t }), logs: [], github: { name: OLD }, settings: { repo: OLD }, tokens: [], cloud: [] } as unknown as World;
	w.api = githubOverMemory(memory, { repo: () => w.github.name, token: () => token ?? w.tokens.at(-1) ?? null });
	w.fetch = (async (url: string | URL, init: RequestInit = {}) => {
		const u = new URL(String(url));
		if (u.origin === CLOUD) {
			w.cloud.push(u.pathname);
			if (u.pathname === '/v1/settings') {
				if (w.settings.repo === 'down') throw new TypeError('fetch failed');
				return Response.json({ site: { name: 'CaraCMS' }, github: { repo: w.settings.repo }, folder: 'sites/site-a/', media: { bucket: null, imageHost: 'img.caracms.cloud' }, imgproxy: { key: 'k', salt: 's' } });
			}
			assert.equal(`${init.method} ${u.pathname}`, 'POST /v1/github/token');
			w.tokens.push(`ghs_token${w.tokens.length + 1}`);
			// The cloud's token route: a different full_name from the mint wins (its M2b), in the answer too.
			return Response.json({ token: w.tokens.at(-1), expiresAt: new Date(clock.t + 60 * MIN).toISOString(), repo: w.github.name });
		}
		assert.equal(u.origin, 'https://api.github.com', `nothing else is asked: ${u.href}`);
		return w.api.answer(u, init);
	}) as typeof fetch;
	return w;
}

async function seed(w: World) {
	if (!w.memory.refs.has('main')) w.memory.seed([...(await siteFiles(site)), { path: 'starter/src/Page.astro', contents: 'page\n' }]);
}

/** A server on the cloud (or, with `github`, self-hosted), its runtime and live editor. */
async function server(w: World, github: LiveSettings['github'] = { kind: 'cloud', key: KEY, url: CLOUD }): Promise<{ ed: LiveEditor; backend: GitHubBackend }> {
	await seed(w);
	const now = () => w.clock.t;
	const log = (line: string) => w.logs.push(line);
	const rt = await createLiveRuntime({ site, settings: { ...base, github }, redis: w.redis, now, log, runningCommit: () => null, fetch: w.fetch });
	assert.ok(rt.backend instanceof GitHubBackend);
	return { ed: await createLiveEditor(rt, { log, sleep: async () => {}, schedule: () => () => {} }), backend: rt.backend };
}

const clone = (d: SiteDocument): SiteDocument => JSON.parse(JSON.stringify(d));
const open = async (ed: LiveEditor) => (await ed.store.read('pages', 'index')) as OpenedDocument;
const intro = (text: string) => JSON.parse(text).blocks[0].intro as string;
const onBranch = (w: World, branch: Branch) => intro(w.memory.file(branch, `starter/${HOME}`)!);

function request(path: string, body?: unknown) {
	const headers: Record<string, string> = { origin: ORIGIN, 'x-caracms-tab': 'tab-aoife-1' };
	if (body !== undefined) headers['content-type'] = 'application/json';
	return new Request(`${ORIGIN}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function write(ed: LiveEditor, text: string) {
	const opened = await open(ed);
	const document = clone(opened.document);
	document.blocks[0]!.data.intro = text;
	const res = await ed.write(request('/_caracms/write', { file: opened.entry.file, base: opened.text, document }), aoife);
	assert.equal(res.status, 200, await res.clone().text());
}

async function poll(ed: LiveEditor): Promise<StatusResponse> {
	const res = await ed.status(request(`/_caracms/status?file=${encodeURIComponent(HOME)}`), aoife);
	assert.equal(res.status, 200, await res.clone().text());
	return (await res.json()) as StatusResponse;
}

async function publish(ed: LiveEditor) {
	const res = await ed.publish(request('/_caracms/publish', {}), aoife);
	return (await res.json()) as { result?: string };
}

/** The repos GitHub was asked about since `from` (updateRefs names the repo by id, so it's left out). */
const reposAsked = (w: World, from: number) => [...new Set(w.api.asked.slice(from).flatMap((a) => (a.repo === null ? [] : [a.repo])))];

beforeEach(() => resetCloudSettings());

describe('finding 7: a repo renamed or transferred on GitHub', () => {
	test('mid-process: the settings confirm it, and saving, the sweep and Publish carry on under the new name with no restart', async () => {
		const w = world();
		await loadCloudSettings({ key: KEY, url: CLOUD, fetch: w.fetch }); // a request's media, as a server's first does
		const { ed, backend } = await server(w);
		assert.equal(backend.gh.nameWithOwner, OLD);
		await write(ed, 'Before the move');
		w.clock.t += 61 * SEC;
		assert.ok((await ed.sweep.tick()).commit);
		assert.equal(onBranch(w, 'drafts'), 'Before the move');

		// The client takes the repo with them: GitHub and the cloud both say the new name now.
		w.github.name = NEW;
		w.settings.repo = NEW;
		const from = w.api.asked.length;
		const cloudFrom = w.cloud.length;
		w.clock.t += 56 * MIN; // the token is due for a refresh
		await write(ed, 'After the move');
		w.clock.t += 61 * SEC;
		const r = await ed.sweep.tick();
		assert.ok(r.commit, 'the sweep committed');
		assert.equal(onBranch(w, 'drafts'), 'After the move', 'and it reached drafts on the renamed repo');
		assert.equal(backend.gh.nameWithOwner, NEW);
		assert.deepEqual(w.cloud.slice(cloudFrom), ['/v1/github/token', '/v1/settings'], 'one token, the settings read once to confirm');
		assert.deepEqual(w.logs.filter((l) => l.includes('repo is now')), [`the site's repo is now ${NEW} (was ${OLD})`], 'one line');
		const held = heldCloudSettings({ key: KEY, url: CLOUD });
		assert.deepEqual(held?.kind === 'ready' ? held.settings.repo : null, { owner: 'example-org', repo: 'website' }, 'the held settings name it too, for a later start in this process');

		const st = await poll(ed);
		assert.deepEqual(st.githubAccess, { kind: 'renamed', title: RENAMED_TITLE, message: renamedMessage(NEW, OLD), link: null });
		assert.equal(st.commitTrouble, null);

		await write(ed, 'Published after the move');
		assert.equal((await publish(ed)).result, 'published');
		assert.equal(onBranch(w, 'main'), 'Published after the move', 'Publish moved main on the renamed repo');
		assert.deepEqual(reposAsked(w, from), [NEW], 'nothing asked under the old name after the move');
		assert.deepEqual((await poll(ed)).githubAccess?.kind, 'renamed', 'the note stays until a restart');

		// A restart (the deploy the Publish set off) starts on the new name, and the note is gone.
		const restarted = await server(w);
		assert.equal(restarted.backend.gh.nameWithOwner, NEW);
		assert.equal((await poll(restarted.ed)).githubAccess, null);
	});

	test("the settings don't name it yet: that refresh is refused as before, and a later one takes it", async () => {
		const w = world();
		const { ed, backend } = await server(w);
		w.github.name = NEW; // the cloud's settings still say OLD
		w.clock.t += 56 * MIN;
		await write(ed, 'Saved during the move');
		w.clock.t += 61 * SEC;
		await assert.rejects(ed.sweep.tick(), (error: Error) => error.message === CLOUD_REPO_CHANGED(NEW));
		assert.equal(backend.gh.nameWithOwner, OLD, 'a name the settings don\'t back up is never taken');
		const refused = (await poll(ed)).githubAccess;
		assert.deepEqual([refused?.kind, refused?.message, refused?.link], ['cloud', CLOUD_REPO_CHANGED(NEW), null]);
		assert.match(CLOUD_REPO_CHANGED(NEW), /^This site's repo is now example-org\/website on GitHub, but CaraCMS Cloud's settings don't say so yet/);
		assert.doesNotMatch(CLOUD_REPO_CHANGED(NEW), /Restart/, 'no restart is asked for');
		assert.notEqual(onBranch(w, 'drafts'), 'Saved during the move');
		assert.ok(await ed.autosaves.get(HOME), 'the edit waits in Redis');
		assert.equal(w.logs.filter((l) => l.includes('repo is now')).length, 0);

		w.settings.repo = NEW;
		w.clock.t += 30 * SEC;
		assert.ok((await ed.sweep.tick()).commit, 'the next refresh takes it');
		assert.equal(onBranch(w, 'drafts'), 'Saved during the move');
		assert.equal(backend.gh.nameWithOwner, NEW);
		assert.equal((await poll(ed)).githubAccess?.kind, 'renamed');
	});

	test("the settings can't be read: refused this time, taken once they can", async () => {
		const w = world();
		const { ed, backend } = await server(w);
		w.github.name = NEW;
		w.settings.repo = 'down';
		w.clock.t += 56 * MIN;
		await write(ed, 'Saved while the cloud blinks');
		w.clock.t += 61 * SEC;
		await assert.rejects(ed.sweep.tick(), (error: Error) => error.message === CLOUD_REPO_CHANGED(NEW));
		assert.equal(backend.gh.nameWithOwner, OLD);
		assert.equal((await poll(ed)).githubAccess?.kind, 'cloud');

		w.settings.repo = NEW;
		w.clock.t += 30 * SEC;
		assert.ok((await ed.sweep.tick()).commit);
		assert.equal(onBranch(w, 'drafts'), 'Saved while the cloud blinks');
		assert.deepEqual((await poll(ed)).githubAccess, { kind: 'renamed', title: RENAMED_TITLE, message: renamedMessage(NEW, OLD), link: null });
	});

	test('a call whose path was made on the old name while it waited for the token goes to the new one', async () => {
		const w = world();
		const { backend } = await server(w);
		const gh = backend.gh;
		w.github.name = w.settings.repo = NEW;
		w.clock.t += 56 * MIN;
		const from = w.api.asked.length;
		await gh.rest('GET', gh.repoPath('/commits?sha=main&per_page=1'));
		await gh.bytes(gh.repoPath(`/tarball/${w.memory.refs.get('main')}`));
		assert.deepEqual(reposAsked(w, from), [NEW]);
	});

	test('a self-hosted site (its own token, no cloud) is unaffected: its repo is its own setting, and the cloud is never asked', async () => {
		const w = world('github_pat_site_a');
		const { ed, backend } = await server(w, { kind: 'token', token: 'github_pat_site_a', owner: 'example-org', repo: 'site-a' });
		w.clock.t += 2 * 60 * MIN;
		await write(ed, 'Self-hosted');
		w.clock.t += 61 * SEC;
		assert.ok((await ed.sweep.tick()).commit);
		assert.equal((await publish(ed)).result, 'published');
		assert.equal(onBranch(w, 'main'), 'Self-hosted');
		assert.equal(backend.gh.nameWithOwner, OLD);
		assert.deepEqual(w.cloud, [], 'no call to the cloud');
		assert.deepEqual(reposAsked(w, 0), [OLD]);
		assert.equal((await poll(ed)).githubAccess, null);
	});
});
