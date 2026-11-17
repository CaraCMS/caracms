/**
 * Which mode the editor runs in, read from the environment (M4 Decision 1).
 *
 * - **Local mode**: `astro dev` with no GitHub credentials (`GITHUB_APP_ID` or
 *   `CARACMS_GITHUB_TOKEN`). M3's editor, files on disk. `CARACMS_CLOUD_KEY` alone stays
 *   local (caracms-cloud: live mode on a laptop never points at a client's repo); the key
 *   is still the images', clips' and forms' credential there. Only the key with
 *   `CARACMS_CLOUD_URL` (the cloud's dev deployment, throwaway repos only) is live in dev.
 * - **Live mode**: whenever a credential is configured, and **always on a production
 *   server**. It needs one GitHub credential (a fine-grained token, or the App's
 *   `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; runs-anywhere Decisions 3–4), the repo
 *   (`GITHUB_REPO=owner/name`, or Railway's `RAILWAY_GIT_REPO_OWNER` and
 *   `RAILWAY_GIT_REPO_NAME`; Decision 6), or CaraCMS Cloud's site key instead of both
 *   (`CARACMS_CLOUD_KEY`, with `CARACMS_CLOUD_URL` for another deployment than
 *   production; caracms-cloud M2 Decision 11: the repo comes from the cloud at start), `CARACMS_SECRET`, `REDIS_URL` and the site's
 *   `https://` address in production (dev may use the stand-in Redis). A production
 *   server missing any of them still serves the public site; `/admin` answers 503
 *   naming them (Phase 2 builds that from `missing`).
 * - **The in-memory GitHub** (Decision 2): `CARACMS_GITHUB=memory`, for tests and local
 *   browser runs, never against the site's own repo. It's live mode with no App and
 *   no repo, and it's **refused in production**.
 *
 * - **The config's `services`** (caracms-cloud M5, live/services.ts, baked in as `Baked.services`):
 *   with it, the other mode's variables are removed before anything here reads them, so the
 *   "not both" sentences below only ever apply to a config without the field (Decision 3);
 *   `'cloud'` without the key is `CLOUD_KEY_MISSING_PROBLEM` on a production server (Decision 4).
 *
 * This only reads; it doesn't wire anything (Phase 2 switches the routes on it,
 * Phase 3 guards with it).
 */
import { CLOUD_KEY_SHAPE, DEFAULT_CLOUD_URL } from './cloud.ts';
import { DEFAULT_BRANCHES, type BranchNames } from './branches.ts';
import { DEFAULT_TIMINGS, type LiveTimings } from './timings.ts';
import { bakedServices, CLOUD_KEY_MISSING_PROBLEM, OWN_FORMS_VARIABLES, OWN_MEDIA_VARIABLES, OWN_MUX_VARIABLES, servicesEnv, type Services } from './services.ts';

export { OWN_FORMS_VARIABLES, OWN_MEDIA_VARIABLES, OWN_MUX_VARIABLES };

export interface LiveSettings {
	/** `memory`: the in-memory GitHub backend (Decision 2). `token`: CARACMS_GITHUB_TOKEN (runs-anywhere Decision 3). */
	github:
		| { kind: 'app'; appId: string; privateKey: string; owner: string; repo: string }
		| { kind: 'token'; token: string; owner: string; repo: string }
		/** CARACMS_CLOUD_KEY (caracms-cloud M2 Decision 11): the repo comes from the cloud when the runtime starts. */
		| { kind: 'cloud'; key: string; url: string }
		| { kind: 'memory' };
	/** Null in dev without REDIS_URL: the in-memory stand-in. */
	redisUrl: string | null;
	/** CARACMS_SECRET: signs sessions (Phase 3). */
	secret: string;
	/** CARACMS_ALLOW, split: exact addresses and `@domain`s, lower-cased and trimmed (Decision 15). */
	allow: string[];
	/** GITHUB_WEBHOOK_SECRET; null means the webhook route answers 404 (Decision 14). */
	webhookSecret: string | null;
	/** Try again through Railway's API (Decision 12): all three, or null. */
	railway: { token: string; serviceId: string; environmentId: string } | null;
	/** Try again through a deploy hook (runs-anywhere Decision 11): CARACMS_DEPLOY_HOOK_URL. A secret: never logged or sent to the browser. */
	deployHook?: string | null;
	/**
	 * The site's public origin (runs-anywhere Decision 7): Astro's `site` (baked at build,
	 * SITE_URL at build included), then SITE_URL, then RAILWAY_PUBLIC_DOMAIN. Never null
	 * in production live mode; missing (a test's settings) means unknown.
	 */
	address?: string | null;
	/** CARACMS_BACKUP_USER and CARACMS_BACKUP_PASSWORD, both or neither (Phase 3 checks the length). */
	backup: { user: string; password: string } | null;
	/** The running commit at start (runs-anywhere Decision 9, `runningCommitFrom`); null with none known. */
	runningCommit: string | null;
	/** The commit baked in at build (`Baked.commit`); status reads the running commit afresh from it and the environment. */
	bakedCommit?: string | null;
	/** Dev only: CARACMS_TIMINGS, a JSON object of LiveTimings to shorten (Decision 2). */
	timings: LiveTimings;
	/**
	 * CARACMS_MAIN_BRANCH and CARACMS_DRAFTS_BRANCH (M9 Decision 6): the refs Publish and
	 * autosave move, `main` and `drafts` unset. readMode always fills it; missing (a test's
	 * settings) means the defaults.
	 */
	branches?: BranchNames;
	production: boolean;
}

export type Mode =
	| { kind: 'local' }
	| { kind: 'live'; settings: LiveSettings }
	/** Live mode, but not usable: `missing` names required variables; `problems` are sentences for anything else wrong. */
	| { kind: 'unconfigured'; missing: string[]; problems: string[] };

type Env = Record<string, string | undefined>;

/** What the build baked in (the integration's defines; editor/server/mode.ts passes them). */
export interface Baked {
	/** Astro's `site` at build: the config's, or SITE_URL's (M6 Decision 3). */
	site?: string | null;
	/** The commit the build was made from (runs-anywhere Decision 9). */
	commit?: string | null;
	/** The config's `services` (caracms-cloud M5 Decision 1; live/services.ts). Null or missing: the key decides (Decision 3). */
	services?: Services | null;
}

// The sentences the configuration problems print, kept here so the docs can quote them.
export const BOTH_CREDENTIALS_PROBLEM =
	'Both a GitHub App (GITHUB_APP_ID) and a token (CARACMS_GITHUB_TOKEN) are set: set one of them, not both.';
export const CLASSIC_TOKEN_PROBLEM =
	'CARACMS_GITHUB_TOKEN is a classic token, which reaches every repo its owner can: use a fine-grained token (it starts with github_pat_) with access to this site\'s repo only.';
export const NOT_FINE_GRAINED_PROBLEM = 'CARACMS_GITHUB_TOKEN must be a fine-grained token: it starts with github_pat_.';
export const NO_ADDRESS_PROBLEM =
	"The site's public address isn't known: set SITE_URL to it, like https://example.com, both when the site is built and when it runs. Without it, sign-in links can't be sent and the editor's saves are refused.";
export const HTTP_ADDRESS_PROBLEM = (address: string) =>
	`The site's address (${address}) is http://, but signing in needs https://: the session cookie is only ever sent over https. Set SITE_URL to the https:// address (http:// works for localhost only).`;
export const CLOUD_KEY_PROBLEM =
	"CARACMS_CLOUD_KEY isn't a CaraCMS Cloud site key: a key is cck_ followed by 43 letters, digits, - and _. Copy it again from app.caracms.com.";
export const CLOUD_AND_GITHUB_PROBLEM = (other: string) =>
	`Both CARACMS_CLOUD_KEY and ${other} are set: a site uses one GitHub credential, so remove ${other}.`;
const listed = (names: readonly string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
export const CLOUD_AND_MEDIA_PROBLEM = (names: readonly string[]) => `Set CARACMS_CLOUD_KEY or the site's own media variables, not both: remove ${listed(names)}.`;
export const CLOUD_AND_MUX_PROBLEM = (names: readonly string[]) => `Set CARACMS_CLOUD_KEY or the site's own Mux variables, not both: remove ${listed(names)}.`;
export const CLOUD_AND_FORMS_PROBLEM = (names: readonly string[]) => `Set CARACMS_CLOUD_KEY or the site's own forms and email variables, not both: remove ${listed(names)}.`;

/** The key beside any of the site's own forms and email variables: Decision 22's sentence, or null. */
export function cloudFormsConflict(env: Env): string | null {
	if (!env.CARACMS_CLOUD_KEY?.trim()) return null;
	const both = OWN_FORMS_VARIABLES.filter((name) => env[name]?.trim());
	return both.length ? CLOUD_AND_FORMS_PROBLEM(both) : null;
}

/**
 * The cloud as the forms and email credential (caracms-cloud M4 Decision 22): the
 * connection when `CARACMS_CLOUD_KEY` is set, with any problems (the site's own forms and
 * email variables beside it, a bad `CARACMS_CLOUD_URL`). Null: not a cloud site. Whether
 * the cloud is *used* is the caller's (only on a production server; the Core framing).
 */
export function cloudForms(env: Env, services: Services | null = bakedServices()): { connection: { key: string; url: string }; problems: string[] } | null {
	env = servicesEnv(env, services);
	const get = (name: string) => env[name]?.trim() || null;
	const key = get('CARACMS_CLOUD_KEY');
	if (!key) return null;
	const conflict = cloudFormsConflict(env);
	const problems: string[] = conflict ? [conflict] : [];
	const url = readCloudUrl(get('CARACMS_CLOUD_URL'), problems);
	return { connection: { key, url }, problems };
}

export const CLOUD_REPO_PROBLEM = 'CARACMS_CLOUD_KEY is set, so the repo comes from CaraCMS Cloud; remove GITHUB_REPO.';
export const CLOUD_URL_PROBLEM = (url: string) =>
	`CARACMS_CLOUD_URL must be the cloud's https:// address (http:// works for localhost only; got "${url}"). Leave it unset for CaraCMS Cloud itself.`;
export const BOTH_REDEPLOYERS_PROBLEM =
	'Both CARACMS_DEPLOY_HOOK_URL and CARACMS_RAILWAY_TOKEN are set: Try again redeploys through one of them, so set only one.';

/** The prefixes of GitHub's classic tokens (`ghp_` and the OAuth, user-to-server, server-to-server and refresh ones). */
const CLASSIC_TOKEN = /^(ghp|gho|ghu|ghs|ghr)_/;

/** On Railway: it sets these on every service (the gate detects the host the same way). */
const onRailway = (env: Env) => Boolean(env.RAILWAY_ENVIRONMENT_ID?.trim() || env.RAILWAY_GIT_REPO_OWNER?.trim() || env.RAILWAY_GIT_REPO_NAME?.trim());

/**
 * The hosts' commit variables, in order (runs-anywhere Decision 9): Railway's, Render's,
 * Coolify's. The build bakes the first one set (or `git rev-parse HEAD`).
 */
export const HOST_COMMIT_VARIABLES = ['RAILWAY_GIT_COMMIT_SHA', 'RENDER_GIT_COMMIT', 'SOURCE_COMMIT'] as const;

/**
 * The running commit (runs-anywhere Decision 9): CARACMS_RUNNING_COMMIT, then a host's
 * variable, then the commit baked in at build. A value at run time wins over the baked
 * one; the in-memory GitHub ignores the baked one (it's this repo's, which the in-memory
 * repo never has). Null with none known.
 */
export function runningCommitFrom(env: Env, baked: string | null | undefined): string | null {
	for (const name of ['CARACMS_RUNNING_COMMIT', ...HOST_COMMIT_VARIABLES]) {
		const v = env[name]?.trim();
		if (v) return v;
	}
	if (env.CARACMS_GITHUB?.trim() === 'memory') return null;
	return baked?.trim() || null;
}

/**
 * The site's public origin (runs-anywhere Decision 7): Astro's `site` as built, then
 * SITE_URL, then Railway's public domain. Null when none is set or SITE_URL doesn't parse
 * (the build already warned).
 */
export function addressFrom(env: Env, bakedSite: string | null | undefined): string | null {
	for (const raw of [bakedSite, env.SITE_URL]) {
		const v = raw?.trim();
		if (!v) continue;
		try {
			const url = new URL(v);
			if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
		} catch {
			/* the next one */
		}
	}
	const railway = env.RAILWAY_PUBLIC_DOMAIN?.trim();
	return railway ? `https://${railway}` : null;
}

const isLocalhost = (host: string) => host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';

/**
 * Read the mode. `production` is whether this is a production server (the
 * integration knows: not `astro dev`); it defaults to `NODE_ENV === 'production'`.
 * `baked` is what the build baked in (the address and the commit).
 */
export function readMode(env: Env = process.env, production = env.NODE_ENV === 'production', baked: Baked = {}): Mode {
	// caracms-cloud M5 Decision 2: with the config's `services`, the other mode's variables are never read.
	const services = baked.services ?? null;
	env = servicesEnv(env, services);
	const get = (name: string) => {
		const v = env[name]?.trim();
		return v ? v : null;
	};
	const memory = get('CARACMS_GITHUB') === 'memory';
	// Never GITHUB_TOKEN (Decision 4): the gh CLI and GitHub Actions export it.
	const ghToken = get('CARACMS_GITHUB_TOKEN');
	const cloudKey = get('CARACMS_CLOUD_KEY');
	// A laptop's key is the production cloud's, so the site's real repo: dev stays local unless CARACMS_CLOUD_URL
	// names another cloud. Production's own address, written out, is not another one.
	const cloudUrl = get('CARACMS_CLOUD_URL');
	const devCloud = cloudKey && cloudUrl && cloudUrl.replace(/\/+$/, '') !== DEFAULT_CLOUD_URL;
	if (!production && !memory && !get('GITHUB_APP_ID') && !ghToken && !devCloud) return { kind: 'local' };

	const missing: string[] = [];
	const problems: string[] = [];
	const need = (name: string) => {
		const v = get(name);
		if (!v) missing.push(name);
		return v ?? '';
	};

	if (memory && production) problems.push('CARACMS_GITHUB=memory is for tests and local runs; a production server never uses the in-memory GitHub.');
	const other = get('CARACMS_GITHUB');
	if (other && other !== 'memory') problems.push(`CARACMS_GITHUB must be "memory" or unset (got "${other}").`);

	let github: LiveSettings['github'] = { kind: 'memory' };
	if (services === 'cloud' && !cloudKey && (!memory || production)) {
		// M5 Decision 4: never the self-hosted variables instead (they were removed above).
		problems.push(CLOUD_KEY_MISSING_PROBLEM);
	} else if (cloudKey && (!memory || production)) {
		// The cloud names the repo (Decision 13), so GITHUB_REPO is a mistake and Railway's own variables are ignored.
		if (!CLOUD_KEY_SHAPE.test(cloudKey)) problems.push(CLOUD_KEY_PROBLEM);
		if (ghToken) problems.push(CLOUD_AND_GITHUB_PROBLEM('CARACMS_GITHUB_TOKEN'));
		if (get('GITHUB_APP_ID')) problems.push(CLOUD_AND_GITHUB_PROBLEM('GITHUB_APP_ID'));
		if (get('GITHUB_REPO')) problems.push(CLOUD_REPO_PROBLEM);
		// M3 Decision 19: the key is the media credential too (unless the tests' in-memory media is on).
		const ownMedia = OWN_MEDIA_VARIABLES.filter((name) => get(name));
		if (ownMedia.length && get('CARACMS_MEDIA') !== 'memory') problems.push(CLOUD_AND_MEDIA_PROBLEM(ownMedia));
		// M4.5 Decision 15: and the video credential.
		const ownMux = OWN_MUX_VARIABLES.filter((name) => get(name));
		if (ownMux.length && get('CARACMS_MEDIA') !== 'memory') problems.push(CLOUD_AND_MUX_PROBLEM(ownMux));
		// M4 Decision 22: and the forms and email credential.
		const formsConflict = cloudFormsConflict(env);
		if (formsConflict) problems.push(formsConflict);
		github = { kind: 'cloud', key: cloudKey, url: readCloudUrl(cloudUrl, problems) };
	} else if (!memory || production) {
		const appId = get('GITHUB_APP_ID');
		const repo = readRepo(env, problems);
		const owner = repo?.owner ?? '';
		const name = repo?.repo ?? '';
		if (appId && ghToken) problems.push(BOTH_CREDENTIALS_PROBLEM);
		if (ghToken) {
			if (CLASSIC_TOKEN.test(ghToken)) problems.push(CLASSIC_TOKEN_PROBLEM);
			else if (!ghToken.startsWith('github_pat_')) problems.push(NOT_FINE_GRAINED_PROBLEM);
			github = { kind: 'token', token: ghToken, owner, repo: name };
		} else if (appId) {
			github = { kind: 'app', appId, privateKey: need('GITHUB_APP_PRIVATE_KEY'), owner, repo: name };
		} else {
			missing.push('CARACMS_CLOUD_KEY (or CARACMS_GITHUB_TOKEN, or GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)');
		}
		if (!repo && !problems.some((p) => p.startsWith('GITHUB_REPO'))) {
			missing.push(onRailway(env) ? 'RAILWAY_GIT_REPO_OWNER and RAILWAY_GIT_REPO_NAME (or GITHUB_REPO)' : 'GITHUB_REPO');
		}
	}
	const secret = need('CARACMS_SECRET');
	const redisUrl = production ? need('REDIS_URL') : get('REDIS_URL');

	// The address (Decision 7): known, and https:// (but for localhost), in production.
	const address = addressFrom(env, baked.site);
	if (production && !address) problems.push(NO_ADDRESS_PROBLEM);
	if (production && address && address.startsWith('http:') && !isLocalhost(new URL(address).hostname)) problems.push(HTTP_ADDRESS_PROBLEM(address));

	const deployHook = get('CARACMS_DEPLOY_HOOK_URL');
	if (deployHook) {
		if (get('CARACMS_RAILWAY_TOKEN')) problems.push(BOTH_REDEPLOYERS_PROBLEM);
		if (!/^https?:\/\//i.test(deployHook)) problems.push('CARACMS_DEPLOY_HOOK_URL must be the hook\'s https:// address.');
	}

	const token = get('CARACMS_RAILWAY_TOKEN');
	const serviceId = get('RAILWAY_SERVICE_ID');
	const environmentId = get('RAILWAY_ENVIRONMENT_ID');
	const user = get('CARACMS_BACKUP_USER');
	const password = env.CARACMS_BACKUP_PASSWORD || null; // a password's spaces are its own

	let timings = { ...DEFAULT_TIMINGS };
	const rawTimings = get('CARACMS_TIMINGS');
	if (rawTimings) {
		if (production) problems.push('CARACMS_TIMINGS is for tests; a production server uses the real timings.');
		else timings = { ...timings, ...parseTimings(rawTimings, problems) };
	}

	const branches = readBranches(get, problems);

	if (missing.length || problems.length) return { kind: 'unconfigured', missing, problems };
	return {
		kind: 'live',
		settings: {
			github,
			redisUrl: redisUrl || null,
			secret,
			allow: (get('CARACMS_ALLOW') ?? '')
				.split(',')
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean),
			webhookSecret: get('GITHUB_WEBHOOK_SECRET'),
			railway: token && serviceId && environmentId ? { token, serviceId, environmentId } : null,
			deployHook,
			address,
			backup: user && password ? { user, password } : null,
			runningCommit: runningCommitFrom(env, baked.commit),
			bakedCommit: baked.commit ?? null,
			timings,
			branches,
			production,
		},
	};
}

/**
 * The branch names (M9 Decision 6). Both set or neither (one alone would leave the other
 * at its default, so a site meant to keep off `main` would still publish to it). Each must
 * be a plain branch name, the two must differ, and autosaves never go to a branch called
 * `main` under another name (that's the branch the settings exist to keep still).
 */
function readBranches(get: (name: string) => string | null, problems: string[]): BranchNames {
	const main = get('CARACMS_MAIN_BRANCH');
	const drafts = get('CARACMS_DRAFTS_BRANCH');
	if ((main === null) !== (drafts === null)) {
		problems.push(`CARACMS_MAIN_BRANCH and CARACMS_DRAFTS_BRANCH must be set together (only ${main === null ? 'CARACMS_DRAFTS_BRANCH' : 'CARACMS_MAIN_BRANCH'} is set), or neither for main and drafts.`);
	}
	const branches: BranchNames = {
		main: get('CARACMS_MAIN_BRANCH') ?? DEFAULT_BRANCHES.main,
		drafts: get('CARACMS_DRAFTS_BRANCH') ?? DEFAULT_BRANCHES.drafts,
	};
	for (const [name, value] of [
		['CARACMS_MAIN_BRANCH', branches.main],
		['CARACMS_DRAFTS_BRANCH', branches.drafts],
	] as const) {
		if (!isBranchName(value)) problems.push(`${name} must be a branch name, like port-caracms (got "${value}").`);
	}
	if (branches.main === branches.drafts) problems.push(`CARACMS_MAIN_BRANCH and CARACMS_DRAFTS_BRANCH must differ (both are "${branches.main}").`);
	else if (branches.drafts === 'main') problems.push('CARACMS_DRAFTS_BRANCH can\'t be main: autosaves would land on main.');
	return branches;
}

/** A plain branch name: no `refs/` prefix, nothing git refuses in a ref. */
function isBranchName(name: string): boolean {
	return (
		/^[A-Za-z0-9._/-]+$/.test(name) &&
		!name.startsWith('refs/') &&
		!/^[-/.]|[/.]$|\.\.|\/\/|\/\.|\.lock$|\.lock\//.test(name)
	);
}

/** CARACMS_CLOUD_URL, without a trailing slash: https://, or http:// on localhost. Unset, the production address. */
export function readCloudUrl(raw: string | null, problems: string[]): string {
	if (!raw) return DEFAULT_CLOUD_URL;
	let url: URL | null = null;
	try {
		url = new URL(raw);
	} catch {
		/* a problem, below */
	}
	if (!url || !(url.protocol === 'https:' || (url.protocol === 'http:' && isLocalhost(url.hostname)))) {
		problems.push(CLOUD_URL_PROBLEM(raw));
		return raw;
	}
	return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** The repo: GITHUB_REPO overrides Railway's own variables (M4 Decision 3; runs-anywhere Decision 6). */
function readRepo(env: Env, problems: string[]): { owner: string; repo: string } | null {
	const override = env.GITHUB_REPO?.trim();
	if (override) {
		const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(override);
		if (!m) {
			problems.push(`GITHUB_REPO must be owner/name (got "${override}").`);
			return null;
		}
		return { owner: m[1]!, repo: m[2]! };
	}
	const owner = env.RAILWAY_GIT_REPO_OWNER?.trim();
	const repo = env.RAILWAY_GIT_REPO_NAME?.trim();
	return owner && repo ? { owner, repo } : null;
}

function parseTimings(raw: string, problems: string[]): Partial<LiveTimings> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		problems.push('CARACMS_TIMINGS must be a JSON object, like {"sweepIdleMs":2000}.');
		return {};
	}
	const out: Partial<LiveTimings> = {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		problems.push('CARACMS_TIMINGS must be a JSON object, like {"sweepIdleMs":2000}.');
		return out;
	}
	for (const [k, v] of Object.entries(value)) {
		if (!Object.hasOwn(DEFAULT_TIMINGS, k)) problems.push(`CARACMS_TIMINGS: "${k}" isn't a timing (${Object.keys(DEFAULT_TIMINGS).join(', ')}).`);
		else if (typeof v !== 'number' || !(v > 0)) problems.push(`CARACMS_TIMINGS: "${k}" must be a positive number of milliseconds.`);
		else out[k as keyof LiveTimings] = v;
	}
	return out;
}

/** The sentence `/admin` shows when live mode isn't usable (Decision 1). */
export function unconfiguredMessage(mode: Extract<Mode, { kind: 'unconfigured' }>): string {
	const parts = [];
	if (mode.missing.length) parts.push(`The editor isn't set up on this server yet: it needs ${mode.missing.join(', ')}.`);
	parts.push(...mode.problems);
	return parts.join(' ');
}
