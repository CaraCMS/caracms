/**
 * GitHub's API over the in-memory GitHub: the REST and GraphQL calls `GitHubBackend` makes,
 * answered by a `MemoryBackend`, so a test can run the real GitHub client (its tokens, its
 * paths, its variables) against a repo it can read back. Only for `https://api.github.com`.
 *
 * Stricter than GitHub in one way: a call that names any repo but `repo()` (an old name after
 * a rename, which GitHub would redirect) is a 404, and so is a call with a token that isn't
 * `token()`'s (a 401), so a test sees anything still asking under a stale name or token.
 */
import { gzipSync } from 'node:zlib';
import { GraphQLError, HttpError } from '../../src/live/github.ts';
import { MissingBranchError, StaleHeadError, type Branch, type MemoryBackend } from '../../src/live/backend.ts';

export interface GitHubOverMemory {
	/** Answers one request to api.github.com. */
	answer(url: URL, init: RequestInit): Promise<Response>;
	/** Every request: its method, path (with the query) and the repo it named (null: none, as updateRefs by id). */
	asked: { method: string; path: string; repo: string | null }[];
}

const REPO_ID = 'R_memory';

/** A ustar archive, gzipped, every file under `top/` (GitHub's tarball). A long name puts `top` in the header's prefix. */
function tarball(top: string, files: Map<string, string>): Buffer {
	const blocks: Buffer[] = [];
	for (const [path, text] of files) {
		const data = Buffer.from(text);
		const header = Buffer.alloc(512);
		const name = `${top}/${path}`;
		if (Buffer.byteLength(name) <= 100) header.write(name, 0, 100);
		else {
			header.write(path, 0, 100);
			header.write(top, 345, 155);
		}
		header.write(data.length.toString(8).padStart(11, '0'), 124, 12);
		header.write('0', 156, 1);
		blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

export function githubOverMemory(memory: MemoryBackend, options: { repo: () => string; token: () => string | null }): GitHubOverMemory {
	const asked: GitHubOverMemory['asked'] = [];
	const role = (ref: string): Branch => {
		const name = ref.replace(/^refs\/heads\//, '');
		const found = (Object.keys(memory.branches) as Branch[]).find((b) => memory.branches[b] === name);
		if (!found) throw new HttpError(404, `No branch ${name}`, null);
		return found;
	};
	const notFound = () => Response.json({ message: 'Not Found' }, { status: 404 });
	const isRepo = (name: string | null) => name !== null && name.toLowerCase() === options.repo().toLowerCase();

	async function graphql(body: { query: string; variables: Record<string, unknown> }): Promise<Response> {
		const { query, variables } = body;
		const input = variables.input as Record<string, unknown> | undefined;
		try {
			if (query.includes('createCommitOnBranch')) {
				const branch = input!.branch as { repositoryNameWithOwner: string; branchName: string };
				asked.push({ method: 'POST', path: '/graphql createCommitOnBranch', repo: branch.repositoryNameWithOwner });
				if (!isRepo(branch.repositoryNameWithOwner)) return Response.json({ data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] });
				const changes = input!.fileChanges as { additions: { path: string; contents: string }[]; deletions: { path: string }[] };
				const message = input!.message as { headline: string; body: string };
				const head = await memory.commitOnBranch(
					role(branch.branchName),
					String(input!.expectedHeadOid),
					changes.additions.map((a) => ({ path: a.path, contents: Buffer.from(a.contents, 'base64').toString('utf8') })),
					changes.deletions.map((d) => d.path),
					message.headline,
					message.body,
				);
				return Response.json({ data: { createCommitOnBranch: { commit: { oid: head.commit, tree: { oid: head.tree } } } } });
			}
			if (query.includes('updateRefs')) {
				asked.push({ method: 'POST', path: '/graphql updateRefs', repo: null });
				if (input!.repositoryId !== REPO_ID) return Response.json({ data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }] });
				const updates = input!.refUpdates as { name: string; beforeOid: string; afterOid: string; force: boolean }[];
				await memory.updateRefs(updates.map((u) => ({ branch: role(u.name), before: u.beforeOid, after: u.afterOid, force: u.force })));
				return Response.json({ data: { updateRefs: { clientMutationId: null } } });
			}
			const repo = `${variables.owner}/${variables.name}`;
			asked.push({ method: 'POST', path: `/graphql ${query.includes('object(expression') ? 'readFiles' : 'readHeads'}`, repo });
			if (!isRepo(repo)) return Response.json({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a Repository with the name '${repo}'.` }] });
			if (query.includes('object(expression')) {
				const items = [...query.matchAll(/f(\d+): object\(expression: ("(?:[^"\\]|\\.)*")\)/g)].map((m) => {
					const expression = JSON.parse(m[2]!) as string;
					const at = expression.indexOf(':');
					return { key: `f${m[1]}`, commit: expression.slice(0, at), path: expression.slice(at + 1) };
				});
				const texts = await memory.readFiles(items);
				return Response.json({ data: { repository: Object.fromEntries(items.map((it, k) => [it.key, texts[k] === null ? null : { text: texts[k] }])) } });
			}
			const node = async (branch: Branch) => {
				const sha = memory.refs.get(memory.branches[branch]);
				if (!sha) return null;
				const tree = (await memory.compare(sha, sha)).mergeBase.tree;
				return { target: { oid: sha, tree: { oid: tree } } };
			};
			await memory.readHeads().catch((error: unknown) => {
				if (!(error instanceof MissingBranchError)) throw error;
			});
			return Response.json({ data: { repository: { id: REPO_ID, main: await node(role(String(variables.main))), drafts: await node(role(String(variables.drafts))) } } });
		} catch (error) {
			if (error instanceof StaleHeadError) return Response.json({ data: null, errors: [{ type: 'STALE_DATA', message: error.message }] });
			if (error instanceof GraphQLError) return Response.json({ data: null, errors: error.errors });
			throw error;
		}
	}

	async function rest(method: string, rest: string, search: URLSearchParams, body: Record<string, unknown> | null): Promise<Response> {
		if (method === 'POST' && rest === '/git/refs') {
			await memory.createBranch(role(String(body!.ref)), String(body!.sha));
			return Response.json({}, { status: 201 });
		}
		if (method === 'GET' && rest.startsWith('/tarball/')) {
			const commit = rest.slice('/tarball/'.length);
			return new Response(new Uint8Array(tarball(`${options.repo().replace('/', '-')}-${commit.slice(0, 7)}`, await memory.readArchive(commit, () => true))));
		}
		if (method === 'GET' && rest.startsWith('/compare/')) {
			const [base, head] = rest.slice('/compare/'.length).split('...') as [string, string];
			const c = await memory.compare(base, head);
			return Response.json({
				status: c.status,
				merge_base_commit: { sha: c.mergeBase.commit, commit: { tree: { sha: c.mergeBase.tree } } },
				commits: c.commits.map((k) => ({ sha: k.sha, parents: k.parents.map((sha) => ({ sha })), commit: { message: k.message, committer: { date: k.date } } })),
				files: (c.files ?? []).map((f) => ({ filename: f.path, status: f.status, sha: f.sha })),
			});
		}
		if (method === 'POST' && rest === '/git/trees') {
			const entries = body!.tree as { path: string; mode: string; sha?: string | null; content?: string }[];
			const tree = await memory.createTree(
				String(body!.base_tree),
				entries.filter((e) => e.content === undefined).map((e) => ({ path: e.path, mode: e.mode, sha: e.sha ?? null })),
				entries.filter((e) => e.content !== undefined).map((e) => ({ path: e.path, contents: e.content! })),
			);
			return Response.json({ sha: tree }, { status: 201 });
		}
		if (method === 'POST' && rest === '/git/commits') {
			return Response.json({ sha: await memory.createCommit(String(body!.tree), body!.parents as string[], String(body!.message)) }, { status: 201 });
		}
		if (method === 'GET' && rest === '/commits') {
			const list = await memory.listCommits(role(search.get('sha')!), Number(search.get('per_page') ?? 30));
			return Response.json(list.map((k) => ({ sha: k.sha, parents: k.parents.map((sha) => ({ sha })), commit: { message: k.message, committer: { date: k.date } } })));
		}
		if (method === 'GET' && rest === '/deployments') {
			const list = await memory.listDeployments(Number(search.get('per_page') ?? 30));
			return Response.json(list.map((d) => ({ id: d.id, sha: d.sha, environment: d.environment, created_at: d.createdAt })));
		}
		const statuses = /^\/deployments\/(\d+)\/statuses$/.exec(rest);
		if (method === 'GET' && statuses) {
			const s = await memory.deploymentStatus(Number(statuses[1]));
			return Response.json(s ? [{ state: s.state, created_at: s.createdAt }] : []);
		}
		return notFound();
	}

	return {
		asked,
		async answer(url, init) {
			const method = init.method ?? 'GET';
			const bearer = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '') ?? null;
			const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
			if (!bearer || bearer !== options.token()) return Response.json({ message: 'Bad credentials' }, { status: 401 });
			try {
				if (url.pathname === '/graphql') return await graphql(body as { query: string; variables: Record<string, unknown> });
				const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
				asked.push({ method, path: `${url.pathname}${url.search}`, repo: m ? m[1]! : null });
				if (!m || !isRepo(m[1]!)) return notFound();
				return await rest(method, m[2] ?? '', url.searchParams, body);
			} catch (error) {
				if (error instanceof HttpError) return Response.json({ message: error.message }, { status: error.status });
				throw error;
			}
		},
	};
}
