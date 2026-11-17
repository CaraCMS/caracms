// Runs anywhere: publish status off Railway. The running
// commit (Decision 9; acceptance checks 19–21), "taking longer than usual" (Decision 10;
// check 23), Deployments refused (check 22), the deploy hook (Decision 11; check 24), no
// host named in the editor's copy (check 26), and Publish's answer inside Cloudflare's 100 s
// (Watch-outs). The in-memory backend and fakes only.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveSite, type SiteConfig } from '../src/config.ts';
import type { PublishResponse, StatusResponse } from '../src/editor/types.ts';
import { buildCommit } from '../src/index.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor } from '../src/live/editor.ts';
import { HttpError, Tracker } from '../src/live/github.ts';
import { LiveGit, NO_REDEPLOYER_REASON, type Redeployer } from '../src/live/git.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { publishState, type PublishRecord } from '../src/live/status.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { siteRoot, variant } from './helpers/site.ts';

const site = resolveSite(variant({ repoPath: 'starter' } as Partial<SiteConfig>), siteRoot);
const aoife = { email: 'aoife@example.com', name: 'Aoife' };
const HOME = 'content/pages/index.json';
const MIN = 60_000;
const HOOK = 'https://api.render.com/deploy/srv-abc123?key=very-secret';

/** A publish on the in-memory backend, with the old server still running (or `running`'s value). */
async function published(options: { running?: () => string | null; redeployer?: Redeployer | null; bakedCommit?: string | null } = {}) {
	let t = Date.parse('2026-10-24T10:00:00Z');
	const backend = new MemoryBackend(new Tracker(), { now: () => t });
	backend.seed(await siteFiles(site));
	const logs: string[] = [];
	const git = new LiveGit({ backend, site, redis: memoryRedis(), now: () => t, log: (l) => logs.push(l), runningCommit: options.running, bakedCommit: options.bakedCommit, redeployer: options.redeployer ?? null });
	await git.start();
	const old = backend.refs.get('main')!;
	const home = git.read(HOME)!;
	await git.commitDrafts([{ file: HOME, base: home, text: home.replace('"title": "Home"', '"title": "Home v2"'), editor: aoife }]);
	const r = await git.publish(aoife);
	assert.equal(r.kind, 'published');
	return { backend, git, logs, old, commit: r.kind === 'published' ? r.record.commit : '', tick: (ms: number) => (t += ms) };
}

describe('the slow state, as a pure function (Decision 10)', () => {
	const record = (over: Partial<PublishRecord> = {}): PublishRecord => ({ commit: 'P', by: aoife, at: '2026-10-24T10:00:00Z', files: [HOME], titles: ['Home'], tryAgainAt: null, ...over });
	const base = { record: record(), running: 'OLD', runningIncludesPublish: false, laterOnMain: new Set<string>(), deployments: [], slowAfterMs: 15 * MIN };
	const at = (iso: string) => Date.parse(iso);

	test('publishing for 15 minutes, then taking longer than usual', () => {
		assert.equal(publishState({ ...base, now: at('2026-10-24T10:14:59Z') }).state, 'publishing');
		assert.equal(publishState({ ...base, now: at('2026-10-24T10:15:00Z') }).state, 'slow');
	});

	test('a Try again restarts the 15 minutes', () => {
		const tried = { ...base, record: record({ tryAgainAt: '2026-10-24T10:20:00Z' }) };
		assert.equal(publishState({ ...tried, now: at('2026-10-24T10:30:00Z') }).state, 'publishing');
		assert.equal(publishState({ ...tried, now: at('2026-10-24T10:35:00Z') }).state, 'slow');
	});

	test('live and failed win: slow is only for "no answer at all"', () => {
		const late = at('2026-10-24T11:00:00Z');
		assert.equal(publishState({ ...base, now: late, running: 'P' }).state, 'live');
		assert.equal(publishState({ ...base, now: late, deployments: [{ sha: 'P', createdAt: '2026-10-24T10:01:00Z', state: 'failure' }] }).state, 'failed');
		assert.equal(publishState({ ...base, now: late, running: null }).state, 'live', 'no running commit at all: today\'s behaviour');
	});
});

describe('the running commit on the server (Decision 9)', () => {
	const saved = { ...process.env };
	after(() => {
		for (const k of ['CARACMS_RUNNING_COMMIT', 'RAILWAY_GIT_COMMIT_SHA', 'RENDER_GIT_COMMIT', 'SOURCE_COMMIT', 'CARACMS_GITHUB']) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});
	const clear = () => {
		for (const k of ['CARACMS_RUNNING_COMMIT', 'RAILWAY_GIT_COMMIT_SHA', 'RENDER_GIT_COMMIT', 'SOURCE_COMMIT', 'CARACMS_GITHUB']) delete process.env[k];
	};

	test('check 19: RENDER_GIT_COMMIT and no Railway variables: publishing, then live once the server runs that commit', async () => {
		clear();
		const { git, old, commit } = await published();
		process.env.RENDER_GIT_COMMIT = old;
		assert.equal((await git.publishStatus()).state, 'publishing');
		process.env.RENDER_GIT_COMMIT = commit;
		assert.equal((await git.publishStatus()).state, 'live');
	});

	test('check 20: the baked commit is used; CARACMS_RUNNING_COMMIT at run time overrides it', async () => {
		clear();
		const first = await published({ bakedCommit: 'will-be-replaced' });
		// The baked commit is the old server's: publishing.
		const { git, old, commit } = await published({ bakedCommit: first.old });
		void old;
		assert.equal((await git.publishStatus()).state, 'publishing');
		process.env.CARACMS_RUNNING_COMMIT = commit;
		assert.equal((await git.publishStatus()).state, 'live');
		// The in-memory GitHub ignores the baked one: with nothing set at run time, today's "no running commit".
		clear();
		process.env.CARACMS_GITHUB = 'memory';
		const st = await git.publishStatus();
		assert.deepEqual([st.state, st.assumed], ['live', true]);
	});

	test('check 20: the build bakes a host variable, else `git rev-parse HEAD` where there is a .git, else nothing', () => {
		assert.equal(buildCommit(siteRoot, { RENDER_GIT_COMMIT: 'abc' }), 'abc');
		assert.equal(buildCommit(siteRoot, { CARACMS_RUNNING_COMMIT: 'x', RAILWAY_GIT_COMMIT_SHA: 'y' }), 'x');
		assert.match(buildCommit(fileURLToPath(new URL('.', import.meta.url)), {}) ?? '', /^[0-9a-f]{40}$/, 'this repo has a .git');
		assert.equal(buildCommit(mkdtempSync(join(tmpdir(), 'caracms-no-git-')), {}), null);
	});

	test('check 21: no running commit known at all: live once the refs moved, and the log says why once', async () => {
		clear();
		const { git, logs } = await published({ running: () => null });
		assert.equal((await git.publishStatus()).state, 'live');
		await git.publishStatus();
		assert.equal(logs.filter((l) => /no running commit known \(CARACMS_RUNNING_COMMIT, a host's commit variable, or one baked in at build\)/.test(l)).length, 1);
	});
});

describe('check 22: Deployments unreadable', () => {
	test('a 403: no further reads, and the log names "Deployments: read" without assuming an App', async () => {
		let reads = 0;
		const running = { value: '' };
		const p = await published({ running: () => running.value });
		running.value = p.old;
		p.backend.listDeployments = async () => {
			reads++;
			throw new HttpError(403, 'GET /deployments -> 403: Resource not accessible by personal access token', null);
		};
		assert.equal((await p.git.publishStatus()).state, 'publishing');
		for (let i = 0; i < 3; i++) {
			p.tick(11_000);
			await p.git.publishStatus();
		}
		assert.equal(reads, 1);
		const line = p.logs.find((l) => /Deployments/.test(l))!;
		assert.match(line, /the site's GitHub token or App needs "Deployments: read"/);
	});
});

describe('check 23: not live after 15 minutes, no failure known', () => {
	test('taking longer than usual, in the status and the history, with Try again when a redeployer is set; after it, publishing for another 15 minutes', async () => {
		const calls: number[] = [];
		const running = { value: '' };
		const p = await published({
			running: () => running.value,
			redeployer: { kind: 'hook', url: HOOK, fetch: (async () => (calls.push(1), new Response(null, { status: 200 }))) as typeof fetch },
		});
		running.value = p.old;
		p.tick(14 * MIN);
		assert.equal((await p.git.publishStatus()).state, 'publishing');
		p.tick(MIN);
		const slow = await p.git.publishStatus();
		assert.deepEqual([slow.state, slow.canTryAgain], ['slow', true]);
		const history = await p.git.history({ refresh: true });
		assert.equal(history.find((h) => h.commit === p.commit)?.state, 'slow');

		assert.deepEqual(await p.git.tryAgain(), { ok: true });
		assert.equal(calls.length, 1);
		assert.equal((await p.git.publishStatus()).state, 'publishing');
		p.tick(14 * MIN);
		assert.equal((await p.git.publishStatus()).state, 'publishing', 'the 15 minutes start again from Try again');
		p.tick(MIN);
		assert.equal((await p.git.publishStatus()).state, 'slow');
	});

	test('a running commit that isn\'t in the repo can never include the publish: taking longer than usual', async () => {
		const p = await published({ running: () => 'f'.repeat(40) });
		p.tick(15 * MIN);
		assert.equal((await p.git.publishStatus()).state, 'slow');
	});

	test('with no redeployer: taking longer than usual, no Try again, and the reason names no host', async () => {
		const running = { value: '' };
		const p = await published({ running: () => running.value });
		running.value = p.old;
		p.tick(15 * MIN);
		assert.deepEqual([(await p.git.publishStatus()).state, (await p.git.publishStatus()).canTryAgain], ['slow', false]);
		assert.deepEqual(await p.git.tryAgain(), { ok: false, reason: NO_REDEPLOYER_REASON });
	});
});

describe('check 24: the deploy hook', () => {
	type Sent = { url: string; method: string | undefined; body: unknown; headers: unknown };

	async function failedPublish(fetcher: typeof fetch) {
		const running = { value: '' };
		const p = await published({ running: () => running.value, redeployer: { kind: 'hook', url: HOOK, fetch: fetcher, timeoutMs: 50 } });
		running.value = p.old;
		p.backend.deployments.push({ id: 1, sha: p.commit, environment: 'production', createdAt: '2026-10-24T10:00:05Z', statuses: [{ state: 'failure', createdAt: '2026-10-24T10:01:00Z' }] });
		p.tick(11_000);
		assert.equal((await p.git.publishStatus()).state, 'failed');
		return p;
	}

	test('one POST per click, no body and no extra headers; a 2xx is success', async () => {
		for (const status of [200, 201, 202, 204]) {
			const sent: Sent[] = [];
			const p = await failedPublish((async (url: string, init: RequestInit) => {
				sent.push({ url: String(url), method: init.method, body: init.body, headers: init.headers });
				return new Response(null, { status });
			}) as typeof fetch);
			assert.deepEqual(await p.git.tryAgain(), { ok: true }, String(status));
			assert.deepEqual(sent, [{ url: HOOK, method: 'POST', body: undefined, headers: undefined }]);
		}
	});

	test('a 4xx, a 5xx, a timeout or a refused connection keeps its reason; nothing is retried; the URL is never logged or returned', async () => {
		const cases: [string, typeof fetch, RegExp][] = [
			['404', (async () => new Response('no', { status: 404 })) as typeof fetch, /the deploy hook answered 404/],
			['500', (async () => new Response('down', { status: 500 })) as typeof fetch, /the deploy hook answered 500/],
			['timeout', ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch, /didn't answer in time/],
			['refused', (async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); }) as typeof fetch, /couldn't be reached/],
		];
		for (const [label, inner, reason] of cases) {
			let calls = 0;
			const p = await failedPublish(((...args: Parameters<typeof fetch>) => (calls++, inner(...args))) as typeof fetch);
			const r = await p.git.tryAgain();
			assert.equal(r.ok, false, label);
			assert.match(!r.ok ? r.reason : '', reason, label);
			assert.equal(calls, 1, `${label}: one call, no retry`);
			assert.equal((await p.git.publishStatus()).state, 'failed', `${label}: still failed`);
			assert.ok(![...p.logs, !r.ok ? r.reason : ''].some((l) => l.includes('very-secret') || l.includes('srv-abc123')), `${label}: the URL stays secret`);
		}
	});

	test('the hook goes nowhere near the browser: the status says only that a redeployer is set', async () => {
		const settings: LiveSettings = { github: { kind: 'memory' }, redisUrl: null, secret: 's'.repeat(32), allow: [], webhookSecret: null, railway: null, deployHook: HOOK, backup: null, runningCommit: null, timings: { ...DEFAULT_TIMINGS }, production: false };
		const backend = new MemoryBackend(new Tracker());
		backend.seed(await siteFiles(site));
		const rt = await createLiveRuntime({ site, settings, backend, redis: memoryRedis(), log: () => {}, runningCommit: () => null });
		const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
		const res = await ed.status(new Request('http://site.test/_caracms/status', { headers: { origin: 'http://site.test' } }), aoife);
		const text = await res.text();
		assert.equal((JSON.parse(text) as StatusResponse).publish.hasRedeployer, true);
		assert.ok(!text.includes('very-secret') && !text.includes('render.com'));
	});
});

describe('Publish answers inside Cloudflare\'s 100 s (Watch-outs)', () => {
	test('a Publish still running at publishAnswerMs answers "joined", running; it carries on and lands', async () => {
		const settings: LiveSettings = { github: { kind: 'memory' }, redisUrl: null, secret: 's'.repeat(32), allow: [], webhookSecret: null, railway: null, backup: null, runningCommit: null, timings: { ...DEFAULT_TIMINGS, publishAnswerMs: 50 }, production: false };
		const backend = new MemoryBackend(new Tracker());
		backend.seed(await siteFiles(site));
		const rt = await createLiveRuntime({ site, settings, backend, redis: memoryRedis(), log: () => {}, runningCommit: () => null });
		const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
		const request = (path: string, body?: unknown) =>
			new Request(`http://site.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { origin: 'http://site.test', 'content-type': 'application/json', 'x-caracms-tab': 'tab-aoife-1' }, body: body === undefined ? undefined : JSON.stringify(body) });
		const opened = (await ed.store.read('pages', 'index')) as { entry: { file: string }; text: string; document: { title: string } };
		const wrote = await ed.write(request('/_caracms/write', { file: opened.entry.file, base: opened.text, document: { ...opened.document, title: 'Home, slowly' } }), aoife);
		assert.equal(wrote.status, 200, await wrote.clone().text());
		const before = backend.refs.get('main');
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		backend.beforeRequest = (endpoint) => (endpoint === 'graphql updateRefs' ? held : undefined);
		const answer = (await (await ed.publish(request('/_caracms/publish', {}), aoife)).json()) as PublishResponse;
		assert.equal(answer.result, 'joined');
		assert.equal(answer.publish.running, true, 'the Publish lock shows it running');
		assert.equal(backend.refs.get('main'), before, 'not landed yet');
		backend.beforeRequest = null;
		release();
		for (let i = 0; i < 50 && backend.refs.get('main') === before; i++) await new Promise((r) => setTimeout(r, 10));
		assert.notEqual(backend.refs.get('main'), before, 'it carried on and landed');
	});
});

describe('check 26: no copy in the editor names Railway', () => {
	test('the editor\'s browser code, its strings and the try-again reason', () => {
		const root = fileURLToPath(new URL('../src/editor/client/', import.meta.url));
		const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.(tsx?|ts)$/.test(f));
		assert.ok(files.length > 20);
		for (const f of files) {
			// Comments may explain where Railway fits; what the editor shows may not name it.
			const code = readFileSync(join(root, f), 'utf8')
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
			assert.doesNotMatch(code, /railway/i, f);
		}
		assert.doesNotMatch(NO_REDEPLOYER_REASON, /railway/i);
	});
});
