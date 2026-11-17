/**
 * CaraCMS Cloud as the site's GitHub credential (caracms-cloud M2, Decisions 11–14).
 *
 * - `CARACMS_CLOUD_KEY` (the site key, `cck_…`) is sent as `Authorization: Bearer` and
 *   nowhere else; `CARACMS_CLOUD_URL` overrides the production address below.
 * - `fetchCloudSettings()`: `GET /v1/settings`, the whole answer the package uses: the
 *   site's repo, its folder and its media (bucket, image host, imgproxy pair; M3).
 *   `loadCloudSettings()` is the one fetch per process (M3 Decision 20): the build's start,
 *   or the first request a server gets, and the live runtime, all share it, held on
 *   `globalThis` (the build renders pages through another module instance than its hooks);
 *   `heldCloudSettings()` reads that copy synchronously (`readMediaConfig`).
 * - `cloudSettings()`: the site's repo from those settings (`github.repo`; null is
 *   `no_repo`, with the cloud's own sentence). Only the editor needs a repo.
 * - `cloudToken()`: `POST /v1/github/token`, a fresh installation token on the site's repo,
 *   about an hour long. `GitHubClient` calls it and refreshes five minutes early. It waits
 *   35 s (`CLOUD_TOKEN_TIMEOUT_MS`), every other call 20 s (`CLOUD_TIMEOUT_MS`).
 * - `confirmCloudRepo()`: a token answer naming another repo is a rename or transfer on
 *   GitHub (the cloud's M2b: "A `full_name` change GitHub reports updates the site's repo").
 *   The settings are read again; when they name it too, the held copy takes the new repo
 *   and `GitHubClient` carries on under it.
 * - **A refusal** (any answer that isn't 2xx, carrying `{ error, message }`) throws a
 *   `CloudRefusal` with the cloud's `message` as it came, and `installUrl` when there is
 *   one. A cloud that can't be reached, or answers with something else, throws a
 *   `CloudRefusal` whose `error` is `unreachable`, with the package's own sentence and a
 *   `detail` for logs (timed out, the connection failed, or the status of an answer that
 *   wasn't the API's).
 *
 * - `cloudUnavailable()`: the sign-in guard's 503 for a refusal at start (Decision 14),
 *   the sentence escaped and the install link a link.
 *
 * The key, the tokens and the imgproxy pair are never logged and never put in an error.
 */

/** The production API's address (caracms-cloud M0 → Contracts). The one place it's written. */
export const DEFAULT_CLOUD_URL = 'https://glad-bird-412.ap-southeast-2.convex.site';

/** A site key: `cck_` and 43 base64url characters (caracms-cloud M1). */
export const CLOUD_KEY_SHAPE = /^cck_[A-Za-z0-9_-]{43}$/;

export const CLOUD_UNREACHABLE = "CaraCMS Cloud couldn't be reached, so the editor can't start. Try again in a minute.";
/** M3 Decision 20: the build's own sentence for a cloud it can't reach. */
export const CLOUD_UNREACHABLE_BUILD = "CaraCMS Cloud couldn't be reached, so the site can't be built. Try again in a minute.";
/**
 * The cloud's own `no_repo` sentence, word for word (caracms-cloud `convex/http.ts`, the token
 * route), for `github.repo: null` in the settings, which carry no sentence of their own. The
 * token route's `no_repo` refusal is shown as it came (`cloudCall`); this is only the copy for
 * the settings (caracms-cloud adversarial review, seam note: it was M1's "Ask CaraCMS to set one").
 */
export const CLOUD_NO_REPO = 'This site has no GitHub repo in CaraCMS Cloud yet. A team owner can pick one in app.caracms.com.';
/**
 * A token answer named another repo than the one the server is on, and the settings, read
 * again, don't say so yet (or couldn't be read): this refresh fails, and the next one asks
 * again (caracms-cloud adversarial review, finding 7; once the settings agree, the new name
 * is taken, github.ts).
 */
export const CLOUD_REPO_CHANGED = (repo: string) =>
	`This site's repo is now ${repo} on GitHub, but CaraCMS Cloud's settings don't say so yet, so changes can't be saved to GitHub for now. The editor tries again on its own; if this stays, ask CaraCMS to check the site.`;

/** How long a call to the cloud may take before it counts as unreachable. */
export const CLOUD_TIMEOUT_MS = 20_000;
/**
 * The token call's own, longer timeout (caracms-cloud adversarial review, seam note): the
 * cloud's worst case, an id mint refused and then the installation found and a token minted
 * by name (10 s to GitHub each), can pass 20 s, which would read as `unreachable`.
 */
export const CLOUD_TOKEN_TIMEOUT_MS = 35_000;

export interface CloudConnection {
	key: string;
	url: string;
	/** For tests. Default: global fetch. */
	fetch?: typeof fetch;
	/** Default: `CLOUD_TIMEOUT_MS`, or `CLOUD_TOKEN_TIMEOUT_MS` for `cloudToken()`. */
	timeoutMs?: number;
}

/**
 * Marks a `CloudRefusal`. `Symbol.for` is shared across module instances, so a refusal
 * thrown by a second copy of this file (Vite's dev SSR graph can hold two) is still known.
 */
const REFUSAL_BRAND = Symbol.for('caracms.CloudRefusal');

/**
 * Is this a `CloudRefusal`, from any instance of this module? Use this, never
 * `instanceof CloudRefusal`: that fails when the refusal came from the other copy.
 */
export function isCloudRefusal(value: unknown): value is CloudRefusal {
	return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[REFUSAL_BRAND] === true;
}

/** The cloud said no (or couldn't be reached). `message` is safe to show and to log. */
export class CloudRefusal extends Error {
	readonly [REFUSAL_BRAND] = true;
	/** The cloud's `error` (`no_repo`, `app_not_installed`, `unknown_key`…), or the package's `unreachable` / `repo_changed` (finding 7: a rename the settings don't confirm yet). */
	readonly error: string;
	/** An `https://` link the message names (the App's install page), or null. */
	readonly installUrl: string | null;
	/** For `unreachable`, what happened, for a log line (never a secret): `timed out`, `answered HTTP 502`… */
	readonly detail: string | null;
	constructor(error: string, message: string, installUrl: string | null = null, detail: string | null = null) {
		super(message);
		this.name = 'CloudRefusal';
		this.error = error;
		this.installUrl = installUrl;
		this.detail = detail;
	}
}

const unreachable = (detail: string | null = null) => new CloudRefusal('unreachable', CLOUD_UNREACHABLE, null, detail);

/**
 * One call to the API: `path` with its query, a JSON `body` for a POST. The answer's JSON
 * object, or a `CloudRefusal` (the cloud's own, or `unreachable`). The media bucket
 * (editor/server/media/cloud-bucket.ts) calls it too.
 */
export async function cloudCall(connection: CloudConnection, method: 'GET' | 'POST', path: string, body?: unknown, defaultTimeoutMs = CLOUD_TIMEOUT_MS): Promise<Record<string, unknown>> {
	let res: Response | undefined;
	let answer: unknown;
	try {
		res = await (connection.fetch ?? fetch)(`${connection.url}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${connection.key}`,
				accept: 'application/json',
				'user-agent': 'caracms',
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(connection.timeoutMs ?? defaultTimeoutMs),
		});
		answer = await res.json();
	} catch (error) {
		const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
		throw unreachable(timedOut ? 'timed out' : res ? `answered HTTP ${res.status}, not with JSON` : 'the connection failed');
	}
	const object = answer && typeof answer === 'object' && !Array.isArray(answer) ? (answer as Record<string, unknown>) : null;
	if (!object) throw unreachable(`answered HTTP ${res.status}, not with an object`);
	if (!res.ok) {
		const { error, message, installUrl } = object;
		if (typeof error !== 'string' || typeof message !== 'string' || !message.trim()) throw unreachable(`answered HTTP ${res.status} without a reason`);
		throw new CloudRefusal(error, message, typeof installUrl === 'string' && /^https:\/\//i.test(installUrl) ? installUrl : null);
	}
	return object;
}

const REPO = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;

/** What the package uses of `GET /v1/settings` (caracms-cloud M1's shape; M3 adds nothing it needs). */
export interface CloudSettings {
	/** The linked repo, or null (`no_repo`, which only the editor minds: a build ignores it). */
	repo: { owner: string; repo: string } | null;
	/** The site's media, or null when the answer lacks any of it (the editor can still start; images can't be built). */
	media: {
		/** The site's folder in the media bucket, `sites/<folder>/`: the prefix the cloud adds to every key. */
		folder: string;
		bucket: string;
		/** Bare, `img.caracms.cloud`. */
		imageHost: string;
		/** imgproxy's pair for this site, hex. Never logged, never sent to a browser. */
		key: string;
		salt: string;
	} | null;
}

/** The package's sentence for settings with no usable media (a cloud set up without its bucket or image host). */
export const CLOUD_NO_MEDIA = "CaraCMS Cloud's settings for this site have no media yet, so images can't be built. Ask CaraCMS to check the site.";

const FOLDER = /^sites\/[a-z0-9][a-z0-9-]*\/$/;
const HOST = /^[A-Za-z0-9.-]+(?::\d+)?$/;
const HEX = /^(?:[0-9a-fA-F]{2})+$/;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** `GET /v1/settings`, checked. No `github` or a malformed repo counts as unreachable; incomplete media is `media: null`. */
export async function fetchCloudSettings(connection: CloudConnection): Promise<CloudSettings> {
	const answer = await cloudCall(connection, 'GET', '/v1/settings');
	const github = answer.github as { repo?: unknown } | undefined;
	const media = answer.media as { bucket?: unknown; imageHost?: unknown } | undefined;
	const pair = answer.imgproxy as { key?: unknown; salt?: unknown } | undefined;
	if (!github || typeof github !== 'object') throw unreachable('answered settings without github');
	const m = typeof github.repo === 'string' ? REPO.exec(github.repo) : null;
	if (github.repo !== null && !m) throw unreachable('answered settings with a malformed repo');
	const folder = str(answer.folder);
	const bucket = str(media && typeof media === 'object' ? media.bucket : null);
	const imageHost = str(media && typeof media === 'object' ? media.imageHost : null);
	const key = str(pair && typeof pair === 'object' ? pair.key : null);
	const salt = str(pair && typeof pair === 'object' ? pair.salt : null);
	const ok = folder && FOLDER.test(folder) && bucket && imageHost && HOST.test(imageHost) && key && HEX.test(key) && salt && HEX.test(salt);
	return { repo: m ? { owner: m[1]!, repo: m[2]! } : null, media: ok ? { folder, bucket, imageHost, key, salt } : null };
}

/** The site's repo (the editor's start): `no_repo` when none is linked. */
export async function cloudSettings(connection: CloudConnection): Promise<{ owner: string; repo: string }> {
	return repoOf(await fetchCloudSettings(connection));
}

export function repoOf(settings: CloudSettings): { owner: string; repo: string } {
	if (!settings.repo) throw new CloudRefusal('no_repo', CLOUD_NO_REPO);
	return settings.repo;
}

// ── The one fetch per process (M3 Decision 20) ─────────────────────────────────

const HELD = Symbol.for('caracms.cloudSettings');
interface Held {
	key: string;
	url: string;
	pending: Promise<CloudSettings> | null;
	value: CloudSettings | null;
	/** The last fetch's refusal, while no fetch has succeeded: the media-unset sentence. */
	failure: CloudRefusal | null;
}
const held = () => globalThis as { [HELD]?: Held };

/**
 * The settings, fetched once per process and shared: the build's start, a server's first
 * request and the live runtime all come here, so there's one `GET /v1/settings`. A fetch
 * that fails is forgotten (its refusal kept for `heldCloudSettings`), so the next caller
 * tries again. Another key or address than the held one fetches afresh (tests).
 */
export function loadCloudSettings(connection: CloudConnection): Promise<CloudSettings> {
	const g = held();
	const h = g[HELD];
	if (h && h.key === connection.key && h.url === connection.url) {
		if (h.value) return Promise.resolve(h.value);
		if (h.pending) return h.pending;
	}
	const next: Held = { key: connection.key, url: connection.url, pending: null, value: null, failure: h?.key === connection.key && h.url === connection.url ? h.failure : null };
	next.pending = fetchCloudSettings(connection).then(
		(value) => {
			next.value = value;
			next.failure = null;
			next.pending = null;
			return value;
		},
		(error: unknown) => {
			next.pending = null;
			next.failure = isCloudRefusal(error) ? error : unreachable();
			throw next.failure;
		},
	);
	g[HELD] = next;
	return next.pending;
}

/** The held copy for this key and address: ready, the last fetch's refusal, or null (not fetched yet, or fetching). */
export function heldCloudSettings(connection: Pick<CloudConnection, 'key' | 'url'>): { kind: 'ready'; settings: CloudSettings } | { kind: 'failed'; refusal: CloudRefusal } | null {
	const h = held()[HELD];
	if (!h || h.key !== connection.key || h.url !== connection.url) return null;
	if (h.value) return { kind: 'ready', settings: h.value };
	return h.failure ? { kind: 'failed', refusal: h.failure } : null;
}

/**
 * caracms-cloud adversarial review, finding 7: a token answer named `fullName`, not the repo
 * the server is on. `GET /v1/settings` afresh: when it names `fullName` too, that repo is
 * returned and the held copy takes it (a start later in this process begins on it; the media
 * are left as held). Null when the settings name another repo, or none, or can't be read.
 */
export async function confirmCloudRepo(connection: CloudConnection, fullName: string): Promise<{ owner: string; repo: string } | null> {
	const settings = await fetchCloudSettings(connection).catch(() => null);
	const repo = settings?.repo ?? null;
	if (!repo || `${repo.owner}/${repo.repo}`.toLowerCase() !== fullName.toLowerCase()) return null;
	const h = held()[HELD];
	if (h?.value && h.key === connection.key && h.url === connection.url) h.value = { ...h.value, repo };
	return repo;
}

/** Forget the held settings (tests). */
export function resetCloudSettings(): void {
	delete held()[HELD];
}

/** A fresh installation token on the site's repo, from `POST /v1/github/token` (35 s unless `timeoutMs` says otherwise). */
export async function cloudToken(connection: CloudConnection): Promise<{ token: string; expiresAt: number; repo: string }> {
	const answer = await cloudCall(connection, 'POST', '/v1/github/token', undefined, CLOUD_TOKEN_TIMEOUT_MS);
	const { token, expiresAt, repo } = answer;
	const at = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
	if (typeof token !== 'string' || !token || Number.isNaN(at) || typeof repo !== 'string') throw unreachable();
	return { token, expiresAt: at, repo };
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * The message as HTML, escaped, with `link` (when there is one) as a link: where the
 * message names it, in place; otherwise after it. The message's words are never changed.
 */
export function messageHtml(message: string, link: string | null): string {
	if (!link) return escapeHtml(message);
	const a = `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`;
	const parts = message.split(link);
	return parts.length > 1 ? parts.map(escapeHtml).join(a) : `${escapeHtml(message)} ${a}`;
}

/** The cloud's refusal at start (Decision 14): its sentence, the install link as a link. */
export function cloudUnavailable(refusal: CloudRefusal, api: boolean): Response {
	const headers = { 'Cache-Control': 'private, no-store' };
	if (api) {
		return new Response(JSON.stringify({ error: refusal.message, code: refusal.error, installUrl: refusal.installUrl }), {
			status: 503,
			headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
		});
	}
	return new Response(
		`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Editor unavailable</title><p>${messageHtml(refusal.message, refusal.installUrl)}</p>`,
		{ status: 503, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } },
	);
}
