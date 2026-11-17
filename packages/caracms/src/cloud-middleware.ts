/**
 * The settings fetch for a cloud site's media (caracms-cloud M3 Decision 20). The package
 * has no boot hook in the built server, so **the first request that reaches the server, of
 * any kind,** fetches `GET /v1/settings` (live/cloud.ts → `loadCloudSettings`) and every
 * request waits on that one shared fetch before anything renders. The live runtime reads the
 * same held answer, so it's one fetch per process. Prerendered pages are files and never wait.
 *
 * - Registered first (`addMiddleware({ order: 'pre' })` in index.ts), before the editor's.
 * - Only for a cloud site's media: `CARACMS_CLOUD_KEY` set, `CARACMS_MEDIA` not `memory`,
 *   and none of the site's own media variables (that's `readMediaConfig`'s problem sentence).
 * - A fetch that fails leaves the media unset (v3's handling: the editor's media routes 503
 *   with the cloud's sentence) and is tried again by a request after `RETRY_MS`, so a cloud
 *   that's away doesn't hold every request for its timeout.
 *
 * `cloudSettingsForBuild()` is the build's start (`astro:build:start`): the same fetch, and
 * a refusal or an unreachable cloud **fails the build** with the cloud's sentence or the
 * package's own. A refusal fails it at once; an unreachable cloud (no answer, a timeout, an
 * answer that isn't the API's, such as a 502 page) is tried again with growing waits for
 * about three minutes first (`BUILD_RETRY_WAITS_MS`, `BUILD_RETRY_WINDOW_MS`), one log line
 * per wait, since a Convex blip during a Publish's deploy would otherwise leave the site
 * unchanged. Only the build retries: the server's first request keeps one try and `RETRY_MS`.
 * The build ignores `github.repo`: a site with no repo linked still builds.
 * The key beside the site's own forms and email variables fails it too (caracms-cloud M4
 * Decision 22), whether or not the media is the cloud's.
 *
 * With the config's `services` (caracms-cloud M5): `'self-hosted'` never fetches (the key is
 * ignored); `'cloud'` without the key fails the build with Decision 4's sentence. The build
 * names the ignored variables once, here; the server, at its first request (`cloudMedia`).
 */
import type { MiddlewareHandler } from 'astro';
import { CLOUD_NO_MEDIA, CLOUD_UNREACHABLE_BUILD, isCloudRefusal, heldCloudSettings, loadCloudSettings } from './live/cloud.ts';
import { cloudFormsConflict } from './live/mode.ts';
import { CLOUD_KEY_MISSING_PROBLEM, servicesEnv, type Services } from './live/services.ts';
import { cloudMedia } from './media.ts';

type Env = Record<string, string | undefined>;

/** After a failed fetch, requests in the next half minute don't wait on another. */
export const RETRY_MS = 30_000;

const NEXT_TRY = Symbol.for('caracms.cloudSettingsNextTry');
const LOGGED = Symbol.for('caracms.cloudSettingsLogged');
type Shared = { [NEXT_TRY]?: number; [LOGGED]?: string };

/** Fetch the settings if this process doesn't hold them yet (and isn't waiting out a failure). */
export async function ensureCloudSettings(env: Env = process.env, now = Date.now(), log: (line: string) => void = (line) => console.error(line)): Promise<void> {
	const cloud = cloudMedia(env);
	if (!cloud || cloud.problems.length) return;
	if (heldCloudSettings(cloud.connection)?.kind === 'ready') return;
	const g = globalThis as Shared;
	if ((g[NEXT_TRY] ?? 0) > now) return;
	try {
		await loadCloudSettings(cloud.connection);
		delete g[NEXT_TRY];
		delete g[LOGGED];
	} catch (error) {
		g[NEXT_TRY] = now + RETRY_MS;
		const line = isCloudRefusal(error) ? `CaraCMS Cloud (${error.error}): ${error.message}` : 'CaraCMS Cloud: the settings could not be read';
		if (g[LOGGED] !== line) log(`[caracms] the media settings could not be fetched: ${line}`);
		g[LOGGED] = line;
	}
}

/** Forget the retry clock (tests). */
export function resetCloudSettingsRetry(): void {
	const g = globalThis as Shared;
	delete g[NEXT_TRY];
	delete g[LOGGED];
}

export const onRequest: MiddlewareHandler = async (_context, next) => {
	await ensureCloudSettings();
	return next();
};

/** The build's waits between tries at an unreachable cloud, in order; the last repeats while the window lasts. */
export const BUILD_RETRY_WAITS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
/** No wait starts that would end more than this long after the first try began. */
export const BUILD_RETRY_WINDOW_MS = 210_000;

/** The build's clock, its waits and its log line (tests). */
export interface BuildRetry {
	now?: () => number;
	wait?: (ms: number) => Promise<void>;
	log?: (line: string) => void;
}

/** The settings for the build: an unreachable cloud is tried again within the window; a refusal is thrown at once. */
async function loadForBuild(connection: Parameters<typeof loadCloudSettings>[0], retry: BuildRetry) {
	const { now = Date.now, wait = (ms) => new Promise<void>((done) => setTimeout(done, ms)), log = (line) => console.warn(line) } = retry;
	const end = now() + BUILD_RETRY_WINDOW_MS;
	for (let tries = 1; ; tries++) {
		try {
			return await loadCloudSettings(connection);
		} catch (error) {
			if (isCloudRefusal(error) && error.error !== 'unreachable') throw error;
			const ms = BUILD_RETRY_WAITS_MS[Math.min(tries, BUILD_RETRY_WAITS_MS.length) - 1]!;
			if (now() + ms > end) throw error;
			const what = isCloudRefusal(error) && error.detail ? ` (${error.detail})` : '';
			const at = new Date(now() + ms).toISOString().slice(11, 19);
			log(`[caracms] CaraCMS Cloud couldn't be reached for the build's settings${what}, try ${tries}; trying again in ${ms / 1000} s, at ${at} UTC.`);
			await wait(ms);
		}
	}
}

/**
 * The build's start: the settings, or an Error with the sentence that fails the build. Nothing for a site off the cloud.
 * `services` is the config's (the integration passes it: this runs outside the bundle, where the build's defines don't reach).
 */
export async function cloudSettingsForBuild(env: Env = process.env, services: Services | null = null, retry: BuildRetry = {}): Promise<void> {
	env = servicesEnv(env, services);
	if (services === 'cloud' && !env.CARACMS_CLOUD_KEY?.trim()) throw new Error(`caracms: ${CLOUD_KEY_MISSING_PROBLEM}`);
	// caracms-cloud M4 Decision 22: the key with the site's own forms and email variables fails the build too.
	const conflict = cloudFormsConflict(env);
	const forms = conflict ? [conflict] : [];
	const cloud = cloudMedia(env, services);
	if (!cloud) {
		if (forms.length) throw new Error(`caracms: ${forms.join(' ')}`);
		return;
	}
	if (cloud.problems.length || forms.length) throw new Error(`caracms: ${[...cloud.problems, ...forms].join(' ')}`);
	let settings;
	try {
		settings = await loadForBuild(cloud.connection, retry);
	} catch (error) {
		const message = isCloudRefusal(error) && error.error !== 'unreachable' ? error.message : CLOUD_UNREACHABLE_BUILD;
		throw new Error(`caracms: ${message}`);
	}
	if (!settings.media) throw new Error(`caracms: ${CLOUD_NO_MEDIA}`);
}
