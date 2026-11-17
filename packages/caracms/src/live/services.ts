/**
 * Where the site's services come from (caracms-cloud M5): the config's `services` field,
 * not whichever variables happen to be set.
 *
 * - **`'cloud'`**: `CARACMS_CLOUD_KEY` is the one credential. The self-hosted variables
 *   (`REPLACED_VARIABLES`) are **removed from the environment the readers see**, so none is
 *   ever read, not even as a fallback (Decision 2, check 5), and each is named once per
 *   process as ignored.
 * - **`'self-hosted'`**: the site's own variables; `CARACMS_CLOUD_KEY` is removed and named
 *   as ignored the same way.
 * - **Unset**: the environment as it is, so the key decides and the "not both" refusals
 *   stand (Decision 3).
 *
 * Every key-or-own reader (live/mode.ts `readMode` and `cloudForms`, media.ts, the editor's
 * media config, forms/store.ts, cloud-middleware.ts, and `media import` in bin/media.mjs)
 * starts from `servicesEnv`. The running site's value is baked in at build
 * (`__CARACMS_SERVICES__`, a Vite define from the config: `bakedServices`), since the readers
 * are synchronous and have no config in hand.
 */
import type { Services } from '../config.ts';

export type { Services };
type Env = Record<string, string | undefined>;

/** The site's own media variables, which `CARACMS_CLOUD_KEY` replaces (caracms-cloud M3 Decision 19). */
export const OWN_MEDIA_VARIABLES = ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'IMGPROXY_KEY', 'IMGPROXY_SALT', 'CARACMS_MEDIA_URL'] as const;
/** The site's own Mux token, which `CARACMS_CLOUD_KEY` replaces (caracms-cloud M4.5 Decision 15). */
export const OWN_MUX_VARIABLES = ['MUX_TOKEN_ID', 'MUX_TOKEN_SECRET'] as const;
/** The site's own forms and email variables, which `CARACMS_CLOUD_KEY` replaces (caracms-cloud M4 Decision 22). */
export const OWN_FORMS_VARIABLES = ['SUBMISSIONS_S3_BUCKET', 'SUBMISSIONS_S3_ACCESS_KEY_ID', 'SUBMISSIONS_S3_SECRET_ACCESS_KEY', 'RESEND_API_KEY', 'FORMS_FROM'] as const;

/** The site's own GitHub variables, which the cloud key replaces (caracms-cloud M2 Decision 11). `GITHUB_WEBHOOK_SECRET` is harmless and not here. */
export const OWN_GITHUB_VARIABLES = ['CARACMS_GITHUB_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_REPO'] as const;

/** Every variable the cloud replaces, by group, in the move list's order of retiring (M5 Contracts). */
export const REPLACED_VARIABLES = {
	media: OWN_MEDIA_VARIABLES,
	video: OWN_MUX_VARIABLES,
	forms: OWN_FORMS_VARIABLES,
	github: OWN_GITHUB_VARIABLES,
} as const;

/** What each group's ignored line ends with: when it can go. */
const RETIRE: Record<keyof typeof REPLACED_VARIABLES, string> = {
	media: 'Remove them once the old bucket and imgproxy are retired.',
	video: 'Remove them once every clip is uploaded again in the editor.',
	forms: 'Remove them once the old submissions are exported or no longer wanted.',
	github: 'Remove them: the cloud gives the site its repo and access.',
};

/** The sentence Decision 4 fails a production build and `/admin` with. */
export const CLOUD_KEY_MISSING_PROBLEM = "This site runs on CaraCMS Cloud (caracms.config.ts), but CARACMS_CLOUD_KEY isn't set. Make a key for it in app.caracms.com.";

const listed = (names: readonly string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The ignored line for some of one group's variables (cloud), or for the key (self-hosted). */
export function ignoredMessage(names: readonly string[], services: Services, group?: keyof typeof REPLACED_VARIABLES): string {
	const one = names.length === 1;
	const set = `${listed(names)} ${one ? 'is' : 'are'} set`;
	if (services === 'self-hosted') return `${set}, but this site is self-hosted (caracms.config.ts): ${one ? "it's" : "they're"} ignored. Remove ${one ? 'it' : 'them'}, or run \`caracms init --cloud\` to move the site to CaraCMS Cloud.`;
	const tail = group ? RETIRE[group] : 'Remove them once the move is done.';
	return `${set}, but this site runs on CaraCMS Cloud (caracms.config.ts): ${one ? "it's" : "they're"} ignored. ${one ? tail.replace(/them/g, 'it') : tail}`;
}

const WARNED = Symbol.for('caracms.ignoredVariables');
type Shared = { [WARNED]?: Set<string> };
const warned = () => ((globalThis as Shared)[WARNED] ??= new Set());

/** Forget which variables were named (tests). */
export function resetIgnoredWarnings(): void {
	delete (globalThis as Shared)[WARNED];
}

const set = (env: Env, name: string) => Boolean(env[name]?.trim());

/**
 * The environment the readers see for this `services` (null: the environment as it is),
 * with the other mode's variables removed. Each removed variable is named once per process
 * (shared on globalThis, so the build's own module and its bundled chunks warn once between them).
 */
export function servicesEnv(env: Env, services: Services | null | undefined, log: (line: string) => void = (line) => console.warn(line)): Env {
	if (!services) return env;
	const seen = warned();
	const out: Env = { ...env };
	if (services === 'self-hosted') {
		if (!set(env, 'CARACMS_CLOUD_KEY')) return env;
		delete out.CARACMS_CLOUD_KEY;
		if (!seen.has('CARACMS_CLOUD_KEY')) log(`[caracms] ${ignoredMessage(['CARACMS_CLOUD_KEY'], services)}`);
		seen.add('CARACMS_CLOUD_KEY');
		return out;
	}
	for (const [group, names] of Object.entries(REPLACED_VARIABLES) as [keyof typeof REPLACED_VARIABLES, readonly string[]][]) {
		const found = names.filter((name) => set(env, name));
		for (const name of found) delete out[name];
		const fresh = found.filter((name) => !seen.has(name));
		if (fresh.length) log(`[caracms] ${ignoredMessage(fresh, services, group)}`);
		for (const name of fresh) seen.add(name);
	}
	return out;
}

/** The names `servicesEnv` would ignore in `env` for `services` (init's move list, tests). */
export function ignoredVariables(env: Env, services: Services | null | undefined): string[] {
	if (!services) return [];
	if (services === 'self-hosted') return set(env, 'CARACMS_CLOUD_KEY') ? ['CARACMS_CLOUD_KEY'] : [];
	return Object.values(REPLACED_VARIABLES).flatMap((names) => names.filter((name) => set(env, name)));
}

declare const __CARACMS_SERVICES__: Services | null | undefined;

/** The config's `services` as the build baked it in; null in plain Node (tests) and for a config without one. */
export function bakedServices(): Services | null {
	return typeof __CARACMS_SERVICES__ === 'string' ? __CARACMS_SERVICES__ : null;
}
