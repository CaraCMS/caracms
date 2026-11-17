/**
 * The live runtime: one per process, built lazily on first use (M4 Phase 1). It holds
 * the GitHub backend, the Redis client, the `drafts` copy and the operations on it
 * (git.ts), and is what Phases 2 and 3 reach for:
 *
 *     const rt = await liveRuntime(site, settings);   // settings: mode.ts → readMode()
 *     rt.git.files().get('content/site-settings.json') // Phase 3's whitelist
 *     rt.git.contentSource()                           // content.ts over the copy
 *     rt.redis                                         // autosaves, locks, sessions
 *     rt.git.commitDrafts([...]); rt.git.publish(person); rt.git.waiting(); rt.git.publishStatus()
 *     rt.git.commitPending = () => sweep.commitAll()  // Phase 2 fills Publish's hook
 *
 * **The in-memory GitHub** (Decision 2): with `CARACMS_GITHUB=memory` the backend is a
 * MemoryBackend seeded from the site's own files on disk as `main`, beside the Redis
 * stand-in, so tests and local browser runs never touch a real repo. It's refused
 * when `NODE_ENV` is `production`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { repoPrefix, type ResolvedSite } from '../config.ts';
import { GitHubBackend, MemoryBackend, type FileWrite, type GitBackend } from './backend.ts';
import { DEFAULT_BRANCHES } from './branches.ts';
import { fetchCloudSettings, heldCloudSettings, loadCloudSettings, repoOf, type CloudConnection } from './cloud.ts';
import { GitHubClient, Tracker } from './github.ts';
import { LiveGit, SITE_SETTINGS_FILE } from './git.ts';
import type { LiveSettings } from './mode.ts';
import { connectRedis, memoryRedis, type RedisClient } from './redis.ts';
import type { LiveTimings } from './timings.ts';

export interface LiveRuntime {
	readonly site: ResolvedSite;
	readonly settings: LiveSettings;
	readonly backend: GitBackend;
	readonly redis: RedisClient;
	/** The copy and every git operation. */
	readonly git: LiveGit;
	readonly timings: LiveTimings;
	/** The clock everything here reads. */
	readonly now: () => number;
	close(): Promise<void>;
}

export interface RuntimeOptions {
	site: ResolvedSite;
	settings: LiveSettings;
	/** Overrides for tests: a backend or Redis already set up, a fake clock. */
	backend?: GitBackend;
	redis?: RedisClient;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	log?: (line: string) => void;
	runningCommit?: () => string | null;
	railwayFetch?: typeof fetch;
	/** Tests: the deploy hook's fetch. */
	deployHookFetch?: typeof fetch;
	/** Tests: the fetch GitHub and CaraCMS Cloud are reached through. */
	fetch?: typeof fetch;
}

/**
 * The repo for the editor's start. M3 Decision 20: the settings the process already holds (the
 * first request fetched them for the media), so one GET /v1/settings, not two; a test's own fetch
 * asks afresh. A held copy with no repo isn't reused: the repo may have been linked since, so
 * this start asks again (one more GET, only while the repo is missing). The held copy is left
 * as it is, so the media keep working off it.
 */
export async function cloudRepoForStart(connection: CloudConnection): Promise<{ owner: string; repo: string }> {
	const held = heldCloudSettings(connection);
	const stale = held?.kind === 'ready' && !held.settings.repo;
	return repoOf(await (connection.fetch || stale ? fetchCloudSettings(connection) : loadCloudSettings(connection)));
}

/** Build and start a runtime (not shared: tests make their own). */
export async function createLiveRuntime(options: RuntimeOptions): Promise<LiveRuntime> {
	const { site, settings } = options;
	const now = options.now ?? Date.now;
	const log = options.log ?? ((line: string) => console.log(`[caracms] ${line}`));
	let backend = options.backend;
	if (!backend) {
		if (settings.github.kind === 'memory') {
			if (settings.production || process.env.NODE_ENV === 'production') {
				throw new Error('caracms: the in-memory GitHub (CARACMS_GITHUB=memory) is refused in production.');
			}
			const memory = new MemoryBackend(new Tracker(now), { now, branches: settings.branches });
			memory.seed(await siteFiles(site));
			log('live mode on the in-memory GitHub, seeded from the site\'s files on disk (CARACMS_GITHUB=memory)');
			backend = memory;
		} else {
			const tracker = new Tracker(now);
			const gh = settings.github;
			const fetch = options.fetch;
			let client: GitHubClient;
			if (gh.kind === 'cloud') {
				// caracms-cloud M2 Decision 13: the repo from the cloud's settings, then the first
				// token, so a refusal of either stops the start (the sign-in guard shows its sentence).
				// A rename on GitHub after this is taken by the client (adversarial review, finding 7).
				const { owner, repo } = await cloudRepoForStart({ key: gh.key, url: gh.url, fetch });
				client = new GitHubClient({ cloudKey: gh.key, cloudUrl: gh.url, owner, repo, now, fetch, log }, tracker);
				await client.ready();
				log(`live mode on ${owner}/${repo} through CaraCMS Cloud`);
			} else {
				const connection =
					gh.kind === 'token' ? { token: gh.token, owner: gh.owner, repo: gh.repo, now, fetch } : { appId: gh.appId, privateKey: gh.privateKey, owner: gh.owner, repo: gh.repo, now, fetch };
				client = new GitHubClient(connection, tracker);
			}
			backend = new GitHubBackend(client, settings.branches);
		}
	}
	const { main, drafts } = backend.branches;
	if (main !== DEFAULT_BRANCHES.main || drafts !== DEFAULT_BRANCHES.drafts) log(`publishing to ${main}, autosaving to ${drafts} (CARACMS_MAIN_BRANCH, CARACMS_DRAFTS_BRANCH)`);
	const redis = options.redis ?? (settings.redisUrl ? connectRedis(settings.redisUrl, { log }) : memoryRedis({ now }));
	if (!options.redis && !settings.redisUrl) log('no REDIS_URL: using the in-memory Redis stand-in (dev only)');
	const git = new LiveGit({
		backend,
		site,
		redis,
		now,
		sleep: options.sleep,
		log,
		runningCommit: options.runningCommit,
		timings: settings.timings,
		bakedCommit: settings.bakedCommit,
		redeployer: settings.deployHook
			? { kind: 'hook', url: settings.deployHook, fetch: options.deployHookFetch }
			: settings.railway
				? { kind: 'railway', ...settings.railway, fetch: options.railwayFetch }
				: null,
	});
	// The copy only: the startup check waits for the live editor (editor.ts), which fills
	// `commitPending` first, so a merge from main never runs ahead of pending autosaves (Decision 8).
	await git.start({ check: false });
	return {
		site,
		settings,
		backend,
		redis,
		git,
		timings: git.timings,
		now,
		async close() {
			await redis.close();
		},
	};
}

const SHARED = Symbol.for('caracms.liveRuntime');
type Shared = { [SHARED]?: Promise<LiveRuntime> };

/**
 * The process's runtime, built on first call and shared after (on `globalThis`, so
 * Vite loading a module twice in dev still gets one). A start that fails is
 * forgotten, so the next request tries again.
 */
export function liveRuntime(site: ResolvedSite, settings: LiveSettings): Promise<LiveRuntime> {
	const g = globalThis as Shared;
	g[SHARED] ??= createLiveRuntime({ site, settings }).catch((error: unknown) => {
		delete g[SHARED];
		throw error;
	});
	return g[SHARED];
}

/** The runtime if one has been built (or is being built), without starting one. */
export function existingLiveRuntime(): Promise<LiveRuntime> | null {
	return (globalThis as Shared)[SHARED] ?? null;
}

/** Forget the shared runtime (tests). */
export async function resetLiveRuntime(): Promise<void> {
	const g = globalThis as Shared;
	const rt = g[SHARED];
	delete g[SHARED];
	await rt?.then((r) => r.close()).catch(() => {});
}

/**
 * The site's files on disk as repo files: every `.json` under the collection folders,
 * plus Site Settings, under the site's `repoPath`. What the in-memory GitHub's `main`
 * starts as.
 */
export async function siteFiles(site: Pick<ResolvedSite, 'root' | 'collections' | 'repoPath'>): Promise<FileWrite[]> {
	const prefix = repoPrefix(site);
	const out: FileWrite[] = [];
	const rel = (abs: string) => relative(site.root, abs).split(sep).join('/');
	for (const c of Object.values(site.collections)) {
		if (c.kind === 'settings') continue; // its one file, below
		let names: string[] = [];
		try {
			names = (await readdir(c.dir, { recursive: true })) as string[];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		for (const name of names.sort()) {
			if (!name.endsWith('.json')) continue;
			const abs = join(c.dir, name);
			out.push({ path: `${prefix}${rel(abs)}`, contents: await readFile(abs, 'utf8') });
		}
	}
	const settings = await readFile(join(site.root, SITE_SETTINGS_FILE), 'utf8').catch(() => null);
	if (settings !== null && !out.some((f) => f.path === `${prefix}${SITE_SETTINGS_FILE}`)) out.push({ path: `${prefix}${SITE_SETTINGS_FILE}`, contents: settings });
	return out;
}
