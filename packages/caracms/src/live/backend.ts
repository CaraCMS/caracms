/**
 * The git calls live mode makes, behind one interface (M4 Phase 1; lifted from M1's
 * git spike), with two implementations:
 *
 * - `GitHubBackend`: the site's repo, as its App (github.ts).
 * - `MemoryBackend`: a tiny in-memory git with GitHub's semantics for these calls,
 *   for tests and local browser runs (M4 Decision 2). It records a request per call
 *   on the same Tracker, so tests can count requests too.
 *
 * Ref moves are always compare-and-swap: `commitOnBranch` names the head it expects,
 * and `updateRefs` names each ref's `before`. A ref that moved underneath is a
 * StaleHeadError. **GitHub reports a stale `beforeOid` as a generic GraphQL error**
 * (M1 → G6 (a)), so callers re-read the heads after *any* `updateRefs` error
 * (ops.ts does).
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { GitHubClient, GraphQLError, HttpError, Tracker, type GitHubAccessProblem } from './github.ts';

export interface Head {
	commit: string;
	tree: string;
}
export interface Heads {
	main: Head;
	drafts: Head;
}

import type { Branch, BranchNames } from './branches.ts';
import { DEFAULT_BRANCHES } from './branches.ts';

export { DEFAULT_BRANCHES, type Branch, type BranchNames };

export interface CommitSummary {
	sha: string;
	parents: string[];
	message: string;
	/** ISO 8601, the committer date. */
	date: string;
}

/** A file that differs between two commits, as it is at the later one. */
export interface FileChange {
	/** Repo path. */
	path: string;
	status: 'added' | 'modified' | 'removed';
	/** The blob at the later commit; null when removed. */
	sha: string | null;
}

export interface Comparison {
	/** `head` relative to `base`: `ahead` means head contains base. */
	status: 'identical' | 'ahead' | 'behind' | 'diverged';
	mergeBase: Head;
	/** Commits in `head` that aren't in `base`, oldest first. */
	commits: CommitSummary[];
	/** Files changed from the merge base to `head`; null when GitHub couldn't list them all. */
	files: FileChange[] | null;
}

export interface FileWrite {
	/** Repo path. */
	path: string;
	contents: string;
}

/** A tree entry laid over a base tree. `sha: null` deletes the path. */
export interface TreeChange {
	path: string;
	mode: string;
	sha: string | null;
}

export interface RefUpdate {
	branch: Branch;
	before: string;
	after: string;
	/** Allow a move that isn't a fast-forward (still checked against `before`). */
	force: boolean;
}

export interface Deployment {
	id: number;
	sha: string;
	environment: string;
	/** ISO 8601. */
	createdAt: string;
}

export interface DeploymentStatus {
	/** GitHub's state: `success`, `failure`, `error`, `inactive`, `in_progress`, `queued`, `pending`. */
	state: string;
	createdAt: string;
}

/** The ref wasn't where we expected: someone else moved it. Re-read, refresh, retry. */
export class StaleHeadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StaleHeadError';
	}
}

/** A branch the caller needs doesn't exist (the first start, before `drafts` is made). */
export class MissingBranchError extends Error {
	readonly branch: Branch;
	constructor(branch: Branch) {
		super(`The ${branch} branch doesn't exist.`);
		this.name = 'MissingBranchError';
		this.branch = branch;
	}
}

export interface GitBackend {
	readonly tracker: Tracker;
	readonly name: 'github' | 'memory';
	/** The ref name behind each role. */
	readonly branches: Readonly<BranchNames>;
	/** Both heads, in one request. Throws MissingBranchError. */
	readHeads(): Promise<Heads>;
	createBranch(branch: Branch, sha: string): Promise<void>;
	/** Every text file at a commit for which `keep(repoPath)` is true, in one download (the archive). */
	readArchive(commit: string, keep: (path: string) => boolean): Promise<Map<string, string>>;
	/** Files' text at commits, in one request; null where a file is absent. */
	readFiles(items: { commit: string; path: string }[]): Promise<(string | null)[]>;
	/** Compare `base...head` (three dots: from their merge base). */
	compare(base: string, head: string): Promise<Comparison>;
	/** One commit on a branch, naming the head it expects. Throws StaleHeadError. */
	commitOnBranch(branch: Branch, expectedHead: string, additions: FileWrite[], deletions: string[], headline: string, body: string): Promise<Head>;
	/** A tree: a base tree with entries laid over it (blob shas) and files written inline. */
	createTree(baseTree: string, changes: TreeChange[], files: FileWrite[]): Promise<string>;
	/** A commit with no author, so GitHub signs it (M1 → G1). */
	createCommit(tree: string, parents: string[], message: string): Promise<string>;
	/** An atomic multi-ref move, each checked against `before`. May throw StaleHeadError, or anything. */
	updateRefs(updates: RefUpdate[]): Promise<void>;
	/** A branch's newest commits, newest first (first parents and merges alike). */
	listCommits(branch: Branch, count: number): Promise<CommitSummary[]>;
	/** The repo's newest deployments, newest first. */
	listDeployments(count: number): Promise<Deployment[]>;
	/** A deployment's newest status, or null when it has none yet. */
	deploymentStatus(id: number): Promise<DeploymentStatus | null>;
	/** What's wrong with GitHub access now, from the responses so far (runs-anywhere Decision 5); null when nothing is. */
	accessProblem(): GitHubAccessProblem | null;
}

/** Is this GraphQL error a stale head (someone moved the ref)? M1 → G6 (a): often it can't tell. */
export function isStaleGraphQL(errors: { type?: string; message?: string }[]): boolean {
	const text = errors.map((e) => `${e.type ?? ''} ${e.message ?? ''}`).join(' | ').toLowerCase();
	return /expected branch to point to|expected .*(oid|head)|beforeoid|before_oid|stale|does not match|is at .* but expected|reference update failed|fast.?forward/.test(text);
}

// ── GitHub ────────────────────────────────────────────────────────────────────

const HEADS_QUERY = `query($owner: String!, $name: String!, $main: String!, $drafts: String!) {
  repository(owner: $owner, name: $name) {
    id
    main: ref(qualifiedName: $main) { target { oid ... on Commit { tree { oid } } } }
    drafts: ref(qualifiedName: $drafts) { target { oid ... on Commit { tree { oid } } } }
  }
}`;

const COMMIT_ON_BRANCH = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid tree { oid } } }
}`;

const UPDATE_REFS = `mutation($input: UpdateRefsInput!) {
  updateRefs(input: $input) { clientMutationId }
}`;

type RefNode = { target: { oid: string; tree: { oid: string } } } | null;

/** GitHub's compare lists at most 300 files; a full list is shorter. */
const COMPARE_FILE_CAP = 300;

export class GitHubBackend implements GitBackend {
	readonly name = 'github';
	readonly gh: GitHubClient;
	readonly branches: Readonly<BranchNames>;
	private repoId = '';

	constructor(gh: GitHubClient, branches: Readonly<BranchNames> = DEFAULT_BRANCHES) {
		this.gh = gh;
		this.branches = branches;
	}
	/** `refs/heads/<name>` for a role. */
	private qualified(branch: Branch) {
		return `refs/heads/${this.branches[branch]}`;
	}
	get tracker() {
		return this.gh.tracker;
	}

	accessProblem(): GitHubAccessProblem | null {
		return this.gh.accessProblem();
	}

	async readHeads(): Promise<Heads> {
		const d = await this.gh.graphql<{ repository: { id: string; main: RefNode; drafts: RefNode } }>(
			HEADS_QUERY,
			{ owner: this.gh.owner, name: this.gh.repo, main: this.qualified('main'), drafts: this.qualified('drafts') },
			'readHeads',
		);
		this.repoId = d.repository.id;
		const head = (n: RefNode, b: Branch): Head => {
			if (!n) throw new MissingBranchError(b);
			return { commit: n.target.oid, tree: n.target.tree.oid };
		};
		return { main: head(d.repository.main, 'main'), drafts: head(d.repository.drafts, 'drafts') };
	}

	async createBranch(branch: Branch, sha: string) {
		await this.gh.rest('POST', this.gh.repoPath('/git/refs'), { ref: this.qualified(branch), sha });
	}

	async readArchive(commit: string, keep: (path: string) => boolean) {
		const tgz = await this.gh.bytes(this.gh.repoPath(`/tarball/${commit}`));
		const out = new Map<string, string>();
		for (const entry of readTar(gunzipSync(tgz))) {
			// GitHub's archive puts everything under one top folder, `<owner>-<repo>-<sha>/`.
			const path = entry.name.slice(entry.name.indexOf('/') + 1);
			if (path && keep(path)) out.set(path, entry.data.toString('utf8'));
		}
		return out;
	}

	async readFiles(items: { commit: string; path: string }[]) {
		const out: (string | null)[] = [];
		for (let i = 0; i < items.length; i += 100) {
			const chunk = items.slice(i, i + 100);
			const fields = chunk.map((it, k) => `f${k}: object(expression: ${JSON.stringify(`${it.commit}:${it.path}`)}) { ... on Blob { text } }`).join('\n');
			const d = await this.gh.graphql<{ repository: Record<string, { text: string | null } | null> }>(
				`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
				{ owner: this.gh.owner, name: this.gh.repo },
				'readFiles',
			);
			chunk.forEach((_, k) => out.push(d.repository[`f${k}`]?.text ?? null));
		}
		return out;
	}

	async compare(base: string, head: string): Promise<Comparison> {
		type Raw = {
			status: Comparison['status'];
			merge_base_commit: { sha: string; commit: { tree: { sha: string } } };
			commits: { sha: string; parents: { sha: string }[]; commit: { message: string; committer: { date: string } } }[];
			files?: { filename: string; status: string; sha: string; previous_filename?: string }[];
		};
		const c = await this.gh.rest<Raw>('GET', this.gh.repoPath(`/compare/${base}...${head}`));
		const raw = c.files ?? [];
		let files: FileChange[] | null = [];
		for (const f of raw) {
			if (f.status === 'removed') files.push({ path: f.filename, status: 'removed', sha: null });
			else if (f.status === 'renamed') {
				if (f.previous_filename) files.push({ path: f.previous_filename, status: 'removed', sha: null });
				files.push({ path: f.filename, status: 'added', sha: f.sha });
			} else if (f.status !== 'unchanged') files.push({ path: f.filename, status: f.status === 'added' ? 'added' : 'modified', sha: f.sha });
		}
		if (raw.length >= COMPARE_FILE_CAP) files = null;
		return {
			status: c.status,
			mergeBase: { commit: c.merge_base_commit.sha, tree: c.merge_base_commit.commit.tree.sha },
			commits: c.commits.map((k) => ({ sha: k.sha, parents: k.parents.map((p) => p.sha), message: k.commit.message, date: k.commit.committer.date })),
			files,
		};
	}

	async commitOnBranch(branch: Branch, expectedHead: string, additions: FileWrite[], deletions: string[], headline: string, body: string) {
		try {
			const d = await this.gh.graphql<{ createCommitOnBranch: { commit: { oid: string; tree: { oid: string } } } }>(
				COMMIT_ON_BRANCH,
				{
					input: {
						branch: { repositoryNameWithOwner: this.gh.nameWithOwner, branchName: this.branches[branch] },
						expectedHeadOid: expectedHead,
						message: { headline, body },
						fileChanges: {
							additions: additions.map((f) => ({ path: f.path, contents: Buffer.from(f.contents).toString('base64') })),
							deletions: deletions.map((path) => ({ path })),
						},
					},
				},
				'createCommitOnBranch',
			);
			return { commit: d.createCommitOnBranch.commit.oid, tree: d.createCommitOnBranch.commit.tree.oid };
		} catch (error) {
			if (error instanceof GraphQLError && isStaleGraphQL(error.errors)) throw new StaleHeadError(error.message);
			throw error;
		}
	}

	async createTree(baseTree: string, changes: TreeChange[], files: FileWrite[]) {
		const t = await this.gh.rest<{ sha: string }>('POST', this.gh.repoPath('/git/trees'), {
			base_tree: baseTree,
			tree: [
				...changes.map((c) => ({ path: c.path, mode: c.mode, type: 'blob', sha: c.sha })),
				...files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.contents })),
			],
		});
		return t.sha;
	}

	async createCommit(tree: string, parents: string[], message: string) {
		const c = await this.gh.rest<{ sha: string }>('POST', this.gh.repoPath('/git/commits'), { message, tree, parents });
		return c.sha;
	}

	async updateRefs(updates: RefUpdate[]) {
		if (!this.repoId) await this.readHeads();
		try {
			await this.gh.graphql(
				UPDATE_REFS,
				{
					input: {
						repositoryId: this.repoId,
						refUpdates: updates.map((u) => ({ name: this.qualified(u.branch), beforeOid: u.before, afterOid: u.after, force: u.force })),
					},
				},
				'updateRefs',
			);
		} catch (error) {
			if (error instanceof GraphQLError && isStaleGraphQL(error.errors)) throw new StaleHeadError(error.message);
			throw error;
		}
	}

	async listCommits(branch: Branch, count: number) {
		const list = await this.gh.rest<{ sha: string; parents: { sha: string }[]; commit: { message: string; committer: { date: string } } }[]>(
			'GET',
			this.gh.repoPath(`/commits?sha=${encodeURIComponent(this.branches[branch])}&per_page=${Math.min(100, count)}`),
		);
		return list.map((k) => ({ sha: k.sha, parents: k.parents.map((p) => p.sha), message: k.commit.message, date: k.commit.committer.date }));
	}

	async listDeployments(count: number) {
		const list = await this.gh.rest<{ id: number; sha: string; environment: string; created_at: string }[]>(
			'GET',
			this.gh.repoPath(`/deployments?per_page=${Math.min(100, count)}`),
		);
		return list.map((d) => ({ id: d.id, sha: d.sha, environment: d.environment, createdAt: d.created_at }));
	}

	async deploymentStatus(id: number) {
		const list = await this.gh.rest<{ state: string; created_at: string }[]>('GET', this.gh.repoPath(`/deployments/${id}/statuses?per_page=1`));
		return list[0] ? { state: list[0].state, createdAt: list[0].created_at } : null;
	}
}

/** The entries of an uncompressed tar (ustar, with pax and GNU long names), regular files only. */
export function readTar(buf: Buffer): { name: string; data: Buffer }[] {
	const out: { name: string; data: Buffer }[] = [];
	const str = (b: Buffer) => {
		const nul = b.indexOf(0);
		return b.subarray(0, nul === -1 ? b.length : nul).toString('utf8');
	};
	let longName: string | null = null;
	let pos = 0;
	while (pos + 512 <= buf.length) {
		const header = buf.subarray(pos, pos + 512);
		if (header.every((b) => b === 0)) break;
		const size = parseInt(str(header.subarray(124, 136)).trim() || '0', 8);
		const type = String.fromCharCode(header[156]!);
		const prefix = str(header.subarray(345, 500));
		const name = longName ?? (prefix ? `${prefix}/${str(header.subarray(0, 100))}` : str(header.subarray(0, 100)));
		const data = buf.subarray(pos + 512, pos + 512 + size);
		pos += 512 + Math.ceil(size / 512) * 512;
		if (type === 'x') {
			// pax: "<len> path=<name>\n" records for the next entry.
			const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
			longName = m ? m[1]! : null;
			continue;
		}
		if (type === 'L') {
			longName = str(data);
			continue;
		}
		longName = null;
		if (type === 'g') continue; // GitHub's global header (the commit id)
		if (type === '0' || type === '\0') out.push({ name, data: Buffer.from(data) });
	}
	return out;
}

// ── In memory ─────────────────────────────────────────────────────────────────

interface MemTreeFile {
	sha: string;
	mode: string;
}
type MemTree = Map<string, MemTreeFile>;

interface MemCommit {
	tree: string;
	parents: string[];
	message: string;
	date: string;
	n: number;
}

/** A deployment as a test lays it out: its statuses oldest first. */
export interface MemoryDeployment extends Deployment {
	statuses: DeploymentStatus[];
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** A git blob's sha, as git computes it. */
export const blobSha = (contents: string) => {
	const bytes = Buffer.from(contents);
	return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};

export class MemoryBackend implements GitBackend {
	readonly name = 'memory';
	readonly tracker: Tracker;
	readonly branches: Readonly<BranchNames>;
	/** Deployments, newest last; tests push to it. */
	deployments: MemoryDeployment[] = [];
	/** Called before each recorded request, with its endpoint: tests inject races here. */
	beforeRequest: ((endpoint: string) => Promise<void> | void) | null = null;
	/** The GitHub access problem the status reports; tests set it (the GitHub client's own is tested with faked responses). */
	access: GitHubAccessProblem | null = null;
	private readonly now: () => number;
	private inHook = false;
	private blobs = new Map<string, string>();
	private trees = new Map<string, MemTree>();
	private commits = new Map<string, MemCommit>();
	/** Every ref, by its name (not its role): a test can seed a branch caracms mustn't touch. */
	refs = new Map<string, string>();
	private n = 0;

	constructor(tracker = new Tracker(), options: { now?: () => number; branches?: Readonly<BranchNames> } = {}) {
		this.tracker = tracker;
		this.now = options.now ?? Date.now;
		this.branches = options.branches ?? DEFAULT_BRANCHES;
	}
	/** The ref name behind a role. */
	private ref(branch: Branch) {
		return this.branches[branch];
	}

	private async rec(endpoint: string, creating: boolean, status = 200) {
		if (this.beforeRequest && !this.inHook) {
			this.inHook = true; // the hook's own calls don't re-enter it
			try {
				await this.beforeRequest(endpoint);
			} finally {
				this.inHook = false;
			}
		}
		this.tracker.record({ endpoint, status, creating });
	}
	private blob(contents: string) {
		const s = blobSha(contents);
		this.blobs.set(s, contents);
		return s;
	}
	private putTree(t: MemTree) {
		const s = sha1(
			[...t.entries()]
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([p, f]) => `${f.mode} ${p} ${f.sha}`)
				.join('\n'),
		);
		this.trees.set(s, new Map(t));
		return s;
	}
	private putCommit(tree: string, parents: string[], message: string) {
		const n = this.n++;
		const s = sha1(`commit:${tree}:${parents.join(',')}:${message}:${n}`);
		this.commits.set(s, { tree, parents, message, date: new Date(this.now()).toISOString(), n });
		return s;
	}
	private ancestors(x: string): Set<string> {
		const seen = new Set<string>();
		const stack = [x];
		while (stack.length) {
			const c = stack.pop()!;
			if (seen.has(c)) continue;
			seen.add(c);
			stack.push(...(this.commits.get(c)?.parents ?? []));
		}
		return seen;
	}
	private isAncestor(a: string, b: string) {
		return this.ancestors(b).has(a);
	}
	private commit(sha: string) {
		const c = this.commits.get(sha);
		if (!c) throw new HttpError(404, `No commit ${sha}`, null);
		return c;
	}
	private head(branch: Branch): Head {
		const c = this.refs.get(this.ref(branch));
		if (!c) throw new MissingBranchError(branch);
		return { commit: c, tree: this.commit(c).tree };
	}
	private summary(sha: string): CommitSummary {
		const c = this.commit(sha);
		return { sha, parents: [...c.parents], message: c.message, date: c.date };
	}
	private fileAt(commit: string, path: string): string | null {
		const f = this.trees.get(this.commit(commit).tree)!.get(path);
		return f ? this.blobs.get(f.sha)! : null;
	}

	// Test helpers (not part of GitBackend; record no requests).

	/** Start the repo: one parentless commit with these files on the main branch (and the drafts branch, if asked). */
	seed(files: FileWrite[], options: { drafts?: boolean } = {}): string {
		const tree = this.putTree(new Map(files.map((f) => [f.path, { sha: this.blob(f.contents), mode: '100644' }])));
		const seed = this.putCommit(tree, [], 'Seed');
		this.refs.set(this.ref('main'), seed);
		if (options.drafts) this.refs.set(this.ref('drafts'), seed);
		return seed;
	}

	/** A developer's push straight to a branch: files written (null deletes), one commit. */
	push(branch: Branch, files: Record<string, string | null>, message = 'A developer push'): string {
		const head = this.head(branch);
		const t = new Map(this.trees.get(head.tree)!);
		for (const [path, contents] of Object.entries(files)) {
			if (contents === null) t.delete(path);
			else t.set(path, { sha: this.blob(contents), mode: '100644' });
		}
		const c = this.putCommit(this.putTree(t), [head.commit], message);
		this.refs.set(this.ref(branch), c);
		return c;
	}

	/** A file's text at a branch's head (null when absent). */
	file(branch: Branch, path: string): string | null {
		return this.fileAt(this.head(branch).commit, path);
	}

	/** Every path at a branch's head. */
	paths(branch: Branch): string[] {
		return [...this.trees.get(this.head(branch).tree)!.keys()].sort();
	}

	/** A commit's parents and message. */
	info(sha: string): CommitSummary {
		return this.summary(sha);
	}

	/** Every commit reachable from a ref (for "nothing orphaned on main" checks). */
	reachable(branch: Branch): Set<string> {
		return this.ancestors(this.head(branch).commit);
	}

	// GitBackend.

	accessProblem(): GitHubAccessProblem | null {
		return this.access;
	}

	async readHeads() {
		await this.rec('graphql readHeads', false);
		return { main: this.head('main'), drafts: this.head('drafts') };
	}

	async createBranch(branch: Branch, sha: string) {
		await this.rec('POST /git/refs', true);
		if (this.refs.has(this.ref(branch))) throw new HttpError(422, 'Reference already exists', null);
		this.commit(sha);
		this.refs.set(this.ref(branch), sha);
	}

	async readArchive(commit: string, keep: (path: string) => boolean) {
		await this.rec('GET /tarball/:ref', false);
		const out = new Map<string, string>();
		for (const [path, f] of this.trees.get(this.commit(commit).tree)!) if (keep(path)) out.set(path, this.blobs.get(f.sha)!);
		return out;
	}

	async readFiles(items: { commit: string; path: string }[]) {
		await this.rec('graphql readFiles', false);
		return items.map((it) => this.fileAt(it.commit, it.path));
	}

	async compare(base: string, head: string): Promise<Comparison> {
		await this.rec('GET /compare/:range', false);
		this.commit(base);
		this.commit(head);
		const status = base === head ? 'identical' : this.isAncestor(base, head) ? 'ahead' : this.isAncestor(head, base) ? 'behind' : 'diverged';
		const ofBase = this.ancestors(base);
		const ofHead = this.ancestors(head);
		const common = [...ofBase].filter((c) => ofHead.has(c));
		const best = common.find((c) => !common.some((o) => o !== c && this.isAncestor(c, o)))!;
		const from = this.trees.get(this.commit(best).tree)!;
		const to = this.trees.get(this.commit(head).tree)!;
		const files: FileChange[] = [];
		for (const path of [...new Set([...from.keys(), ...to.keys()])].sort()) {
			const a = from.get(path);
			const b = to.get(path);
			if (a?.sha === b?.sha && a?.mode === b?.mode) continue;
			files.push({ path, status: !a ? 'added' : !b ? 'removed' : 'modified', sha: b?.sha ?? null });
		}
		const commits = [...ofHead]
			.filter((c) => !ofBase.has(c))
			.sort((x, y) => this.commit(x).n - this.commit(y).n)
			.map((c) => this.summary(c));
		return { status, mergeBase: { commit: best, tree: this.commit(best).tree }, commits, files };
	}

	async commitOnBranch(branch: Branch, expectedHead: string, additions: FileWrite[], deletions: string[], headline: string, body: string) {
		await this.rec('graphql createCommitOnBranch', true);
		const cur = this.refs.get(this.ref(branch));
		if (cur !== expectedHead) throw new StaleHeadError(`Expected branch to point to "${expectedHead}" but it did not. Pull and try again.`);
		const t = new Map(this.trees.get(this.commit(cur).tree)!);
		for (const f of additions) t.set(f.path, { sha: this.blob(f.contents), mode: '100644' });
		for (const p of deletions) t.delete(p);
		const tree = this.putTree(t);
		const c = this.putCommit(tree, [cur], body ? `${headline}\n\n${body}` : headline);
		this.refs.set(this.ref(branch), c);
		return { commit: c, tree };
	}

	async createTree(baseTree: string, changes: TreeChange[], files: FileWrite[]) {
		await this.rec('POST /git/trees', true);
		const t = new Map(this.trees.get(baseTree)!);
		for (const c of changes) {
			if (c.sha === null) t.delete(c.path);
			else t.set(c.path, { sha: c.sha, mode: c.mode });
		}
		for (const f of files) t.set(f.path, { sha: this.blob(f.contents), mode: '100644' });
		return this.putTree(t);
	}

	async createCommit(tree: string, parents: string[], message: string) {
		await this.rec('POST /git/commits', true);
		if (!this.trees.has(tree)) throw new HttpError(422, `No tree ${tree}`, null);
		return this.putCommit(tree, parents, message);
	}

	async updateRefs(updates: RefUpdate[]) {
		await this.rec('graphql updateRefs', true);
		for (const u of updates) {
			// GitHub's answer here is a generic error, not a typed one (M1 → G6 (a)).
			if (this.refs.get(this.ref(u.branch)) !== u.before) throw new GraphQLError([{ message: 'Something went wrong while executing your query.' }]);
			if (!u.force && !this.isAncestor(u.before, u.after)) throw new GraphQLError([{ message: 'Something went wrong while executing your query.' }]);
		}
		for (const u of updates) this.refs.set(this.ref(u.branch), u.after); // all or nothing
	}

	async listCommits(branch: Branch, count: number) {
		await this.rec('GET /commits', false);
		return [...this.ancestors(this.head(branch).commit)]
			.sort((x, y) => this.commit(y).n - this.commit(x).n)
			.slice(0, count)
			.map((c) => this.summary(c));
	}

	async listDeployments(count: number) {
		await this.rec('GET /deployments', false);
		return [...this.deployments].reverse().slice(0, count).map(({ statuses: _, ...d }) => d);
	}

	async deploymentStatus(id: number) {
		await this.rec('GET /deployments/:id/statuses', false);
		const d = this.deployments.find((x) => x.id === id);
		const s = d?.statuses.at(-1);
		return s ? { ...s } : null;
	}
}
