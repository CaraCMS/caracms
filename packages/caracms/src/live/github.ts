/**
 * GitHub as the site's App or a fine-grained token (M4 Phase 1, lifted from M1's git spike;
 * the token from runs-anywhere Decision 3).
 *
 * - **A fine-grained token** (`CARACMS_GITHUB_TOKEN`) is the bearer as it is. GitHub sends
 *   its expiry on every response, which is kept for the editor (Decision 5).
 * - **The App's JWT**: RS256, signed with the App's private key, `iat` backdated a
 *   minute for clock drift, nine minutes long (GitHub's limit is ten).
 * - **An installation token scoped to the one repo**: the installation is found with
 *   `GET /repos/{owner}/{repo}/installation`, and the token is minted for that repo
 *   only. It's refreshed five minutes before it expires (they last an hour).
 * - Every response is recorded by a Tracker, tagged with the operation it belongs to,
 *   so a run can be checked against the content-creating cap (80 a minute, 500 an
 *   hour; M1 → G4).
 *
 * - **Every request times out** after `timeoutMs` (20 s), its body included: a GitHub
 *   that stops answering fails the operation instead of holding it (and Publish's or
 *   the check's callers) forever. The cloud's token call is the one exception: 35 s
 *   unless `timeoutMs` is given (cloud.ts, `CLOUD_TOKEN_TIMEOUT_MS`).
 *
 * - **Access problems** (Decision 5): every response is watched for a refused credential
 *   (401), a write refused for lack of a permission (403 "not accessible"), and, for a
 *   token, an expiry within 14 days. `accessProblem()` says which holds now; a later
 *   success clears the first two.
 *
 * - **CaraCMS Cloud** (`CARACMS_CLOUD_KEY`; caracms-cloud M2 Decisions 12–14) mints the
 *   installation token instead: `POST /v1/github/token` (cloud.ts), refreshed five minutes
 *   early like the App's. A refusal from the cloud is an access problem of kind `cloud`
 *   carrying the cloud's sentence (and its install link), cleared by the next token.
 * - **A rename or transfer on GitHub** (caracms-cloud adversarial review, finding 7; this
 *   retires M2 Decision 13's refusal of a token answer for another repo, whose only way out
 *   was a developer restarting the server): the settings are read again, and when they name
 *   the new repo too, the client takes that name for the rest of the process. Every path,
 *   GraphQL variable and commit asks for it from then on (the backend reads `owner`, `repo`
 *   and `nameWithOwner` on each call), a call that was waiting on the token is moved to it,
 *   one line is logged and the editor gets an information note (`renamed`) until the next
 *   restart. Settings that don't name it yet, or can't be read, fail that refresh as an
 *   access problem of kind `cloud`; the next token asks again.
 *
 * The private key, the site key and the tokens are never logged.
 */
import { createSign } from 'node:crypto';
import { CLOUD_REPO_CHANGED, CloudRefusal, confirmCloudRepo, isCloudRefusal, cloudToken } from './cloud.ts';

const API = 'https://api.github.com';

interface ConnectionBase {
	owner: string;
	repo: string;
	/** For tests. Default: global fetch. */
	fetch?: typeof fetch;
	/** Default: Date.now. */
	now?: () => number;
	/** How long one request may take, response body included, before it fails (default 20 s). */
	timeoutMs?: number;
}

export interface AppConnection extends ConnectionBase {
	appId: string;
	/** The PEM. Railway variables often carry it with literal `\n`s; those are turned back into newlines. */
	privateKey: string;
}

/** A fine-grained personal access token on the one repo (Decision 3). */
export interface TokenConnection extends ConnectionBase {
	token: string;
}

/** CaraCMS Cloud mints the token (caracms-cloud M2 Decision 12); `fetch` reaches the cloud as well as GitHub. */
export interface CloudConnection extends ConnectionBase {
	cloudKey: string;
	cloudUrl: string;
	/** Finding 7's one line when the repo's new name is taken. Default: the console, as `[caracms] …`. */
	log?: (line: string) => void;
}

export type GitHubConnection = AppConnection | TokenConnection | CloudConnection;

/** Which credential a client signs in with. */
export type GitHubCredential = 'app' | 'token' | 'cloud';

/**
 * What's wrong with GitHub access right now (Decision 5), shown in the editor while it holds.
 * `credential` says which one the site uses, so the sentence names the right fix.
 */
export type GitHubAccessProblem =
	| { kind: 'refused'; credential: GitHubCredential }
	| { kind: 'permission'; credential: GitHubCredential; permission: string }
	| { kind: 'expiring'; credential: 'token'; expires: string }
	/** CaraCMS Cloud refused a token (caracms-cloud M2 Decision 14): its sentence as it came, and its install link. */
	| { kind: 'cloud'; credential: 'cloud'; message: string; installUrl: string | null }
	/** Not a problem: information (finding 7). The repo was renamed or transferred, and work carries on under `repo`. */
	| { kind: 'renamed'; credential: 'cloud'; repo: string; was: string };

/** A token expiring within this long shows in the editor (Decision 5). */
export const TOKEN_EXPIRY_WARNING_MS = 14 * 24 * 60 * 60_000;

/** The permission every write needs; Deployments read is optional and never shown (Decision 10). */
const CONTENTS_PERMISSION = 'Contents: Read and write';

/**
 * `github-authentication-token-expiration`: "2026-11-03 10:00:00 UTC" or "… -0700".
 * Null when it doesn't parse.
 */
export function parseTokenExpiry(value: string | null): number | null {
	const m = value && /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/i.exec(value.trim());
	if (!m) return null;
	const zone = !m[3] || /^(utc|z)$/i.test(m[3]) ? 'Z' : m[3].replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
	const at = Date.parse(`${m[1]}T${m[2]}${zone}`);
	return Number.isNaN(at) ? null : at;
}

/** The sentence the editor shows for an access problem, for the developer it's forwarded to. */
export function accessProblemMessage(problem: GitHubAccessProblem): string {
	const what = problem.credential === 'token' ? 'GitHub token (CARACMS_GITHUB_TOKEN)' : 'GitHub App';
	switch (problem.kind) {
		case 'refused':
			if (problem.credential === 'cloud') {
				return "GitHub refused the token CaraCMS Cloud gave this site: the caracms App may have been uninstalled from the repo or suspended. Changes can't be saved to GitHub until it's installed again; ask CaraCMS to check the site.";
			}
			return problem.credential === 'token'
				? `GitHub refused this site's ${what}: it may have expired or been revoked. Changes can't be saved to GitHub until a developer makes a new fine-grained token and sets it.`
				: `GitHub refused this site's ${what}: it may have been uninstalled from the repo or suspended. Changes can't be saved to GitHub until a developer reinstalls it.`;
		case 'permission':
			if (problem.credential === 'cloud') {
				return `GitHub refused a change because the caracms App, through CaraCMS Cloud, lacks the "${problem.permission}" permission on this site's repo. Ask CaraCMS to check the App.`;
			}
			return `GitHub refused a change because this site's ${what} lacks the "${problem.permission}" permission. A developer can add it in the ${problem.credential === 'token' ? "token's settings" : "App's settings"}.`;
		case 'cloud':
			return problem.message;
		case 'renamed':
			return `This site's GitHub repo is now ${problem.repo} (it was ${problem.was}). Changes save and publish to it as before; nothing needs doing.`;
		case 'expiring': {
			const date = new Date(problem.expires).toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
			return `This site's ${what} expires on ${date}. After that, changes can't be saved to GitHub: a developer can regenerate it, or make a new one, and set it before then.`;
		}
	}
}

/** A GitHub request that takes longer than this fails (its caller treats it as any failure). */
export const GITHUB_TIMEOUT_MS = 20_000;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** The App's JWT. */
export function appJwt(appId: string, key: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
	const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
	const signer = createSign('RSA-SHA256');
	signer.update(`${header}.${payload}`);
	return `${header}.${payload}.${b64url(signer.sign(key))}`;
}

export class HttpError extends Error {
	readonly status: number;
	readonly body: unknown;
	constructor(status: number, message: string, body: unknown) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
		this.body = body;
	}
}

export class GraphQLError extends Error {
	readonly errors: { type?: string; message?: string }[];
	constructor(errors: { type?: string; message?: string }[]) {
		super(`GraphQL: ${errors.map((e) => `${e.type ?? '?'}: ${e.message}`).join(' | ')}`);
		this.name = 'GraphQLError';
		this.errors = errors;
	}
}

/** One request, as the Tracker keeps it. */
export interface RequestRecord {
	/** The operation instance: `draft #2`, `publish #1`. */
	op: string;
	/** Its kind: `draft`, `publish`, `merge`, `start`, `check`, `status`… */
	kind: string;
	/** `POST /git/commits`, `graphql createCommitOnBranch`. */
	endpoint: string;
	status: number;
	/** Counts against GitHub's content-creating cap. */
	creating: boolean;
	at: number;
}

/** Is this request content-creating in GitHub's sense? */
export function isContentCreating(method: string, path: string, graphqlMutation: boolean): boolean {
	if (graphqlMutation) return true;
	if (method === 'GET' || method === 'HEAD') return false;
	return /\/git\/(blobs|trees|commits|refs)|\/contents\/|\/merges$|\/deployments/.test(path);
}

/** Records every request against the operation running at the time. */
export class Tracker {
	records: RequestRecord[] = [];
	private op = 'other';
	private kind = 'other';
	private counters = new Map<string, number>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** Run `fn` with its requests tagged as one instance of `kind` (`draft` → `draft #2`). */
	async within<T>(kind: string, fn: () => Promise<T>): Promise<T> {
		const prev = [this.op, this.kind] as const;
		const n = (this.counters.get(kind) ?? 0) + 1;
		this.counters.set(kind, n);
		this.op = `${kind} #${n}`;
		this.kind = kind;
		try {
			return await fn();
		} finally {
			[this.op, this.kind] = prev;
		}
	}

	record(r: { endpoint: string; status: number; creating: boolean }) {
		this.records.push({ ...r, op: this.op, kind: this.kind, at: this.now() });
		if (this.records.length > 2000) this.records.splice(0, this.records.length - 2000);
	}

	/** Content-creating requests in the last `ms` (the cap is 80 a minute, 500 an hour). */
	creatingWithin(ms: number): number {
		const since = this.now() - ms;
		return this.records.filter((r) => r.creating && r.at >= since).length;
	}
}

/** `/git/commits/abc…` → `/git/commits/:sha`, so a table groups by endpoint. */
function shorten(p: string): string {
	return p
		.replace(/\b[0-9a-f]{40}\b/g, ':sha')
		.replace(/\/compare\/.*$/, '/compare/:range')
		.replace(/\/git\/refs\/heads\/.*$/, '/git/refs/heads/:branch')
		.replace(/\/git\/ref\/heads\/.*$/, '/git/ref/heads/:branch')
		.replace(/\/tarball\/.*$/, '/tarball/:ref')
		.replace(/\/deployments\/\d+/, '/deployments/:id')
		.replace(/\/contents\/.*$/, '/contents/:path');
}

export class GitHubClient {
	readonly tracker: Tracker;
	/** Which credential this client signs in with. */
	readonly credential: GitHubCredential;
	private readonly appId: string;
	private readonly key: string;
	private readonly cloud: { key: string; url: string } | null = null;
	private readonly fetcher: typeof fetch;
	private readonly now: () => number;
	private readonly timeoutMs: number;
	/** The connection's own `timeoutMs` (tests), else undefined: the token call then waits its 35 s (cloud.ts). */
	private readonly givenTimeoutMs: number | undefined;
	private token = '';
	private tokenExpires = 0;
	private signingIn: Promise<void> | null = null;
	/** Decision 5: what the last responses said about access. */
	private refused = false;
	private missingPermission: string | null = null;
	private personalTokenExpires: number | null = null;
	/** The cloud's last refusal, until a token comes. */
	private cloudProblem: { message: string; installUrl: string | null } | null = null;
	/** The repo, as the server started on it or as a rename made it since (finding 7). */
	private name: { owner: string; repo: string };
	/** The name before the last rename taken, for the editor's note until a restart. */
	private renamedFrom: string | null = null;
	private readonly log: (line: string) => void = (line) => console.log(`[caracms] ${line}`);

	constructor(connection: GitHubConnection, tracker: Tracker) {
		if ('token' in connection) {
			this.credential = 'token';
			this.appId = '';
			this.key = '';
			this.token = connection.token;
			this.tokenExpires = Number.POSITIVE_INFINITY;
		} else if ('cloudKey' in connection) {
			this.credential = 'cloud';
			this.appId = '';
			this.key = '';
			this.cloud = { key: connection.cloudKey, url: connection.cloudUrl };
			if (connection.log) this.log = connection.log;
		} else {
			this.credential = 'app';
			this.appId = connection.appId;
			this.key = connection.privateKey.includes('\\n') ? connection.privateKey.replace(/\\n/g, '\n') : connection.privateKey;
		}
		this.name = { owner: connection.owner, repo: connection.repo };
		this.fetcher = connection.fetch ?? fetch;
		this.now = connection.now ?? Date.now;
		this.timeoutMs = connection.timeoutMs ?? GITHUB_TIMEOUT_MS;
		this.givenTimeoutMs = connection.timeoutMs;
		this.tracker = tracker;
	}

	/** What's wrong with GitHub access now, the most serious first; null when nothing is (Decision 5). */
	accessProblem(): GitHubAccessProblem | null {
		if (this.cloudProblem) return { kind: 'cloud', credential: 'cloud', ...this.cloudProblem };
		if (this.refused) return { kind: 'refused', credential: this.credential };
		if (this.missingPermission) return { kind: 'permission', credential: this.credential, permission: this.missingPermission };
		const expires = this.personalTokenExpires;
		if (this.credential === 'token' && expires !== null && expires - this.now() < TOKEN_EXPIRY_WARNING_MS) {
			return { kind: 'expiring', credential: 'token', expires: new Date(expires).toISOString() };
		}
		if (this.renamedFrom) return { kind: 'renamed', credential: 'cloud', repo: this.nameWithOwner, was: this.renamedFrom };
		return null;
	}

	/**
	 * Keep what a response says about access. A 401 is a refused credential. A write
	 * refused for lack of a permission (`notPermitted`: a 403 or a GraphQL error saying
	 * "not accessible") is a missing permission, except on Deployments (optional,
	 * Decision 10); a rate limit's 403 isn't one. Any success clears a refusal; a
	 * successful write clears a missing permission.
	 */
	private observe(res: Response, path: string, write: boolean, notPermitted: boolean, hadErrors = false): void {
		if (this.credential === 'token') {
			const expires = parseTokenExpiry(res.headers.get('github-authentication-token-expiration'));
			if (expires !== null) this.personalTokenExpires = expires;
		}
		if (res.status === 401) this.refused = true;
		else if (res.ok && !notPermitted) {
			this.refused = false;
			if (write && !hadErrors) this.missingPermission = null; // a GraphQL 200 carrying errors didn't land
		}
		if (notPermitted && write && !/\/deployments/.test(path)) this.missingPermission = CONTENTS_PERMISSION;
	}

	get owner() {
		return this.name.owner;
	}

	get repo() {
		return this.name.repo;
	}

	get nameWithOwner() {
		return `${this.owner}/${this.repo}`;
	}

	repoPath(p = ''): string {
		return `/repos/${this.owner}/${this.repo}${p}`;
	}

	/** Find the App's installation on the repo and mint a token for that repo only. */
	private async signIn(): Promise<void> {
		const jwt = appJwt(this.appId, this.key, Math.floor(this.now() / 1000));
		const install = (await this.request('GET', this.repoPath('/installation'), undefined, jwt).catch((error: unknown) => {
			if (error instanceof HttpError && error.status === 404) {
				this.refused = true;
				throw new Error(`The GitHub App (id ${this.appId}) isn't installed on ${this.nameWithOwner}. Install it on that repo.`);
			}
			throw error;
		})) as { id: number };
		const tok = (await this.request('POST', `/app/installations/${install.id}/access_tokens`, { repositories: [this.repo] }, jwt, true)) as {
			token: string;
			expires_at: string;
		};
		this.token = tok.token;
		this.tokenExpires = Date.parse(tok.expires_at);
	}

	/**
	 * Ask CaraCMS Cloud for a token. A refusal is kept as the access problem (and thrown); a
	 * cloud that can't be reached only fails this call, as an unreachable GitHub does.
	 */
	private async cloudSignIn(cloud: { key: string; url: string }): Promise<void> {
		let answer;
		try {
			// Seam note (caracms-cloud adversarial review): the token route's worst case passes 20 s, so
			// it gets cloud.ts's 35 s; the settings read below keeps the 20 s every other call has.
			answer = await cloudToken({ ...cloud, fetch: this.fetcher, timeoutMs: this.givenTimeoutMs });
		} catch (error) {
			if (isCloudRefusal(error) && error.error !== 'unreachable') this.cloudProblem = { message: error.message, installUrl: error.installUrl };
			throw error;
		}
		if (answer.repo.toLowerCase() !== this.nameWithOwner.toLowerCase()) {
			// Finding 7: a rename or transfer. Taken only when the settings, read again, name it too.
			const repo = await confirmCloudRepo({ ...cloud, fetch: this.fetcher, timeoutMs: this.timeoutMs }, answer.repo);
			if (!repo) {
				const refusal = new CloudRefusal('repo_changed', CLOUD_REPO_CHANGED(answer.repo));
				this.cloudProblem = { message: refusal.message, installUrl: null };
				throw refusal;
			}
			const was = this.nameWithOwner;
			this.name = repo;
			this.renamedFrom = was;
			this.log(`the site's repo is now ${this.nameWithOwner} (was ${was})`);
		}
		this.cloudProblem = null;
		this.token = answer.token;
		this.tokenExpires = answer.expiresAt;
	}

	/** Sign in now (the cloud's first token at start, so a refusal stops the start). */
	async ready(): Promise<void> {
		await this.auth();
	}

	/** The installation token, refreshed five minutes before it expires; a personal token as it is. */
	private async auth(): Promise<string> {
		if (this.credential === 'token') return this.token;
		if (!this.token || this.now() > this.tokenExpires - 5 * 60_000) {
			this.signingIn ??= (this.cloud ? this.cloudSignIn(this.cloud) : this.signIn()).finally(() => {
				this.signingIn = null;
			});
			await this.signingIn;
		}
		return this.token;
	}

	async rest<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
		const was = this.nameWithOwner;
		const bearer = await this.auth();
		return (await this.request(method, this.movedPath(path, was), body, bearer)) as T;
	}

	/** A GET whose body is bytes (the tarball). Follows GitHub's redirect to codeload. */
	async bytes(path: string): Promise<Buffer> {
		const was = this.nameWithOwner;
		const bearer = await this.auth();
		path = this.movedPath(path, was);
		const res = await this.fetcher(`${API}${path}`, { headers: this.headers(bearer), redirect: 'follow', signal: this.signal() });
		this.tracker.record({ endpoint: `GET ${shorten(path.replace(/^\/repos\/[^/]+\/[^/]+/, '').replace(/\?.*$/, ''))}`, status: res.status, creating: false });
		this.observe(res, path, false, false);
		if (!res.ok) throw new HttpError(res.status, `GET ${path} -> ${res.status}`, await res.text().catch(() => ''));
		return Buffer.from(await res.arrayBuffer());
	}

	/**
	 * Finding 7: a call's path was made on `was` (its caller read `repoPath()` before the
	 * token), and the token it waited for took a new name. It goes to the new name, so no
	 * call after a rename leans on GitHub's redirect from the old one.
	 */
	private movedPath(path: string, was: string): string {
		const from = `/repos/${was}`;
		return was !== this.nameWithOwner && (path === from || path.startsWith(`${from}/`) || path.startsWith(`${from}?`)) ? `/repos/${this.nameWithOwner}${path.slice(from.length)}` : path;
	}

	/** The same for GraphQL's variables: an `owner` and `name` pair, or a `repositoryNameWithOwner`, on `was`. */
	private movedVariables(value: unknown, was: string): unknown {
		if (was === this.nameWithOwner || !value || typeof value !== 'object') return value;
		if (Array.isArray(value)) return value.map((v) => this.movedVariables(v, was));
		const o = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.movedVariables(v, was)]));
		if (o.repositoryNameWithOwner === was) o.repositoryNameWithOwner = this.nameWithOwner;
		if (`${o.owner}/${o.name}` === was) Object.assign(o, { owner: this.owner, name: this.repo });
		return o;
	}

	/** Aborts the request (and the reading of its body) after `timeoutMs`. */
	private signal(): AbortSignal {
		return AbortSignal.timeout(this.timeoutMs);
	}

	private headers(bearer: string, json = false): Record<string, string> {
		return {
			authorization: `Bearer ${bearer}`,
			accept: 'application/vnd.github+json',
			'x-github-api-version': '2022-11-28',
			'user-agent': 'caracms',
			...(json ? { 'content-type': 'application/json' } : {}),
		};
	}

	private async request(method: string, path: string, body: unknown, bearer: string, notCreating = false): Promise<unknown> {
		const res = await this.fetcher(`${API}${path}`, {
			method,
			headers: this.headers(bearer, body !== undefined),
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: this.signal(),
		});
		const endpointPath = path.replace(/^\/repos\/[^/]+\/[^/]+/, '').replace(/\?.*$/, '');
		const creating = !notCreating && isContentCreating(method, path, false);
		this.tracker.record({ endpoint: `${method} ${shorten(endpointPath)}`, status: res.status, creating });
		const text = await res.text();
		let json: unknown = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = text;
		}
		const message = (json as { message?: string } | null)?.message ?? text.slice(0, 200);
		this.observe(res, path, creating, res.status === 403 && /not accessible/i.test(message));
		if (!res.ok) {
			throw new HttpError(res.status, `${method} ${endpointPath} -> ${res.status}: ${message}`, json);
		}
		return json;
	}

	/** GraphQL as the installation (or the token). Throws GraphQLError when the answer has `errors`. */
	async graphql<T = unknown>(query: string, variables: Record<string, unknown>, name: string): Promise<T> {
		const isMutation = /^\s*mutation\b/.test(query);
		const was = this.nameWithOwner;
		const bearer = await this.auth();
		const res = await this.fetcher(`${API}/graphql`, {
			method: 'POST',
			// updateRefs worked with this preview header in M1 (G2); whether it still needs it is untested (G6 (f)).
			headers: { ...this.headers(bearer, true), accept: 'application/vnd.github.update-refs-preview+json, application/json' },
			body: JSON.stringify({ query, variables: this.movedVariables(variables, was) }),
			signal: this.signal(),
		});
		this.tracker.record({ endpoint: `graphql ${name}`, status: res.status, creating: isMutation });
		const json = (await res.json().catch((error: unknown) => {
			if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw error; // timed out mid-body
			return {};
		})) as { data?: T; errors?: { type?: string; message?: string }[] };
		const notPermitted = (json.errors ?? []).some((e) => e.type === 'FORBIDDEN' || /not accessible/i.test(e.message ?? ''));
		this.observe(res, '/graphql', isMutation, notPermitted, (json.errors?.length ?? 0) > 0);
		if (!res.ok && !json.errors) throw new HttpError(res.status, `graphql ${name} -> ${res.status}`, json);
		if (json.errors?.length) throw new GraphQLError(json.errors);
		return json.data as T;
	}
}
