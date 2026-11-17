/**
 * The submissions store (M6 Decision 7): one JSON object per submission, its files
 * beside it, behind one interface with three backends.
 *
 * - **Production** (`NODE_ENV=production`): the site's own submissions bucket,
 *   `SUBMISSIONS_S3_BUCKET` with `SUBMISSIONS_S3_ACCESS_KEY_ID` and
 *   `SUBMISSIONS_S3_SECRET_ACCESS_KEY`, at the media bucket's `S3_ENDPOINT` and
 *   `S3_REGION`. A **second** bucket: imgproxy holds the media bucket's keys and never
 *   gets these. **The production server never falls back to disk**: with any of them
 *   unset, the store is `unset` (the endpoint's 502, the inbox's sentence).
 * - **Everywhere else**: `.caracms/submissions/` under the site's root (gitignored),
 *   **even with the bucket variables or the cloud key set**, so a laptop never lands a test enquiry in
 *   the client's inbox, nor copies their visitors' data down.
 * - **CaraCMS Cloud** (caracms-cloud M4 Decision 23): a production server with
 *   `CARACMS_CLOUD_KEY` stores through the cloud's API (cloud-store.ts), and the cloud sends
 *   the email. The key with any of the site's own forms and email variables is `unset`
 *   with Decision 22's sentence.
 * - **`CARACMS_SUBMISSIONS=memory`**: in memory, one per process, for tests. Refused in
 *   production, as `CARACMS_MEDIA=memory` is.
 *
 * The data model is the template's (`forms.md` → Data model), `v: 1` without `onSubmit`:
 * the key `<id>.json`, the files `<id>/<n>-<safe name>`. Ids sort in received order, so
 * newest-first is a key sort; a page reads its own objects. `create()` writes the files,
 * then the JSON, and removes what it wrote if anything fails. `delete()` removes the
 * files, then the JSON, so a failure part-way leaves the submission listed. Every id is
 * checked against the id pattern, and every stored key against `isFileKey`, before it
 * becomes a key or a path.
 *
 * **The unread count** (Decision 9) is kept per store in this process: built on first
 * use from every object, then kept by every write, which all go through this server
 * (one replica). So the documents list and every inbox response carry it without
 * reading the bucket each time.
 */
import { createHash, randomInt } from 'node:crypto';
import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { cloudForms } from '../live/mode.ts';
import { bakedServices, CLOUD_KEY_MISSING_PROBLEM, servicesEnv, type Services } from '../live/services.ts';
import { cloudStore } from './cloud-store.ts';
import { isSubmissionId, shownFileName, type FormFieldValue } from './rules.ts';

type Env = Record<string, string | undefined>;

export interface StoredFile {
	/** The visitor's own name, for display only (control and bidi characters removed). */
	name: string;
	size: number;
	/** The declared type, possibly blank. Never trusted: a download's type comes from the key. */
	type: string;
	/** `<id>/1-Site-plan.pdf`: where the bytes are. */
	key: string;
}

export interface EmailOutcome {
	/**
	 * `held` is only ever the cloud's answer (caracms-cloud adversarial review, finding 20): the
	 * email waits behind the site's daily limit and goes out when it's raised or the next UTC day.
	 * It's never stored by the package's own stores.
	 */
	status: 'sent' | 'failed' | 'skipped' | 'held';
	/** When it was sent, failed or was skipped; for `held`, when it was held. */
	at: string;
	to: string[];
	/** Resend's message on failure, why it was skipped, or the cloud's sentence for a held one. */
	error?: string;
}

/** The Tina template's forms data model, version 1, without `onSubmit`. */
export interface StoredSubmission {
	v: 1;
	id: string;
	/** A form id from the config, never the raw hidden field. */
	form: string;
	/** ISO 8601 UTC. */
	receivedAt: string;
	/**
	 * Each field's trimmed value by name (`''` for an optional one left blank); not its files. A
	 * rows field's is a list of rows, each its cells as text by column name (form rows Decision 9);
	 * a stored record is never reshaped on read, so a template record's lists load as they are.
	 */
	fields: Record<string, FormFieldValue>;
	/** The attachments in the order sent; absent when there are none. */
	files?: StoredFile[];
	/** Null: unread. */
	readAt: string | null;
	/** Absent: not attempted yet, or the server died mid-way (the inbox says "unknown"). */
	email?: EmailOutcome;
	/**
	 * Only ever the cloud's: why the attachments that came with it weren't kept (the site
	 * reached its daily attachment limit in CaraCMS Cloud), as a sentence the inbox shows in
	 * place of "No files". Absent otherwise.
	 */
	filesNote?: string;
	/**
	 * Only ever the cloud's (email feedback, 2026-11-11): its spam check marked this as possibly
	 * spam at `at`, so the email is held (`email.status: 'held'`) until someone says it isn't
	 * (`SubmissionStore.notSpam`). Absent: not flagged.
	 */
	spam?: { at: string };
}

export interface NewFile {
	name: string;
	type: string;
	data: Uint8Array;
}

/**
 * What a cloud site's server sends with a submission (caracms-cloud M4 Decision 11): the
 * email, written, or the reason there is none. The cloud sends it once the row is stored.
 */
export type WrittenEmail =
	| { email: { to: string[]; subject: string; text: string; replyTo?: string; fromName: string } }
	| { emailSkipped: string }
	| { emailFailed: string };

export interface SubmissionStore {
	/**
	 * `email` writes the email for the submission as stored (its id, files and time), and only
	 * the cloud store calls it (M4 Decision 23): it may call it twice, when the cloud already
	 * had the first id. The other stores ignore it; the endpoint sends their email itself.
	 */
	create(input: { form: string; receivedAt: string; fields: Record<string, FormFieldValue>; files?: NewFile[]; email?: (submission: StoredSubmission) => WrittenEmail }): Promise<StoredSubmission>;
	/** True for the cloud store: the email goes with `create`, and the cloud sends it and records the outcome. */
	readonly sendsEmail?: boolean;
	get(id: string): Promise<StoredSubmission | null>;
	getFile(id: string, n: number): Promise<{ file: StoredFile; body: Uint8Array } | null>;
	/** Newest first, `limit` (default 50) after `before`; `older` is the cursor for the next page, or null. */
	list(options?: { limit?: number; before?: string }): Promise<{ items: StoredSubmission[]; older: string | null }>;
	/** Rewrite one (last write wins). Null when there's no such submission. */
	update(id: string, patch: Partial<Pick<StoredSubmission, 'readAt' | 'email'>>): Promise<StoredSubmission | null>;
	/** The files, then the JSON. False when there was no such submission. */
	delete(id: string): Promise<boolean>;
	/**
	 * "Not spam, send it": the flag goes and the held email is sent. The submission as it is
	 * now (unchanged when it wasn't flagged), or null when there's no such submission. Only the
	 * cloud store flags spam, so only it (and the memory store, for tests) has this; without it,
	 * the inbox answers as for an unknown id.
	 */
	notSpam?(id: string): Promise<StoredSubmission | null>;
	unreadCount(): Promise<number>;
}

export const PAGE_SIZE = 50;
/** The longest a safe name gets, its extension included. */
export const SAFE_NAME_MAX = 100;
const NAME_MAX = 255;

/** Where a site's submissions live outside production, relative to its root (gitignored). */
export const LOCAL_SUBMISSIONS_FOLDER = '.caracms/submissions';

export const SUBMISSIONS_ENV = ['SUBMISSIONS_S3_BUCKET', 'SUBMISSIONS_S3_ACCESS_KEY_ID', 'SUBMISSIONS_S3_SECRET_ACCESS_KEY'] as const;
const SHARED_ENV = ['S3_ENDPOINT', 'S3_REGION'] as const;

export const SUBMISSIONS_MEMORY_IN_PRODUCTION = 'CARACMS_SUBMISSIONS=memory is for tests; a production server never keeps submissions in memory.';

/** A visitor's file name as kept for display: control characters and bidi overrides removed, trimmed, at most 255 characters. */
export function cleanFileName(name: unknown): string {
	return String(name ?? '')
		.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
		.trim()
		.slice(0, NAME_MAX);
}

/** A name's extension, lower case, no dot (`Plan.PDF` → `pdf`); '' when it has none. */
export function fileExtension(name: string): string {
	const base = shownFileName(name);
	const dot = base.lastIndexOf('.');
	return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

/** The name a file is stored under: the basename, anything but letters, digits, `.`, `-` and `_` turned to `-`, at most 100 characters, the extension kept. */
export function safeFileName(name: string): string {
	const base = shownFileName(name).replace(/[^A-Za-z0-9._-]/g, '-') || 'file';
	if (base.length <= SAFE_NAME_MAX) return base;
	const dot = base.lastIndexOf('.');
	const ext = dot > 0 && base.length - dot <= 20 ? base.slice(dot) : '';
	return base.slice(0, SAFE_NAME_MAX - ext.length) + ext;
}

/** `<id>/<n>-<safe name>`, n from 1. The `<n>-` prefix means no segment can be `.` or `..`. */
export const fileKey = (id: string, n: number, name: string): string => `${id}/${n}-${safeFileName(name)}`;

/** Is this a key `create()` would have made for this submission? Checked before every read or delete. */
export function isFileKey(id: string, key: unknown): key is string {
	return isSubmissionId(id) && typeof key === 'string' && key.startsWith(`${id}/`) && /^\d{1,3}-[A-Za-z0-9._-]{1,100}$/.test(key.slice(id.length + 1));
}

/** `2026-09-25T09:14:02.123Z` → `2026-09-25T09-14-02-123Z_k3f9a2`. */
export function newSubmissionId(receivedAt: string): string {
	const stamp = new Date(receivedAt);
	if (Number.isNaN(stamp.getTime())) throw new Error(`submissions: receivedAt is not a date: ${receivedAt}`);
	return `${stamp.toISOString().replace(/[:.]/g, '-')}_${randomInt(0, 36 ** 6).toString(36).padStart(6, '0')}`;
}

// ── Backends ─────────────────────────────────────────────────────────────────

/** What a backend does: objects by key, and the submissions' ids (the top-level `<id>.json` keys). */
export interface Backend {
	put(key: string, body: Uint8Array, contentType: string): Promise<void>;
	/** Null when there's no such object. */
	get(key: string): Promise<Uint8Array | null>;
	/** Removing a key that isn't there is fine. */
	remove(key: string): Promise<void>;
	ids(): Promise<string[]>;
	/** Tidy an emptied `<id>/` (the folder backend). */
	removeFolder?(id: string): Promise<void>;
}

/** In memory: one object map. `failOn` makes a test's chosen call fail (a bucket that refuses part-way). */
export class MemoryBackend implements Backend {
	readonly objects = new Map<string, Uint8Array>();
	/** Every call, in order (`put:<key>`, `get:<key>`, `remove:<key>`, `ids`). */
	readonly calls: string[] = [];
	failOn: ((call: string) => boolean) | null = null;
	private check(call: string) {
		this.calls.push(call);
		if (this.failOn?.(call)) throw new Error(`memory submissions: ${call} failed (a test asked)`);
	}
	async put(key: string, body: Uint8Array, _contentType?: string) {
		this.check(`put:${key}`);
		this.objects.set(key, new Uint8Array(body));
	}
	async get(key: string) {
		this.check(`get:${key}`);
		const body = this.objects.get(key);
		return body ? new Uint8Array(body) : null;
	}
	async remove(key: string) {
		this.check(`remove:${key}`);
		this.objects.delete(key);
	}
	async ids() {
		this.check('ids');
		return [...this.objects.keys()].filter((k) => !k.includes('/') && k.endsWith('.json')).map((k) => k.slice(0, -5));
	}
	clear() {
		this.objects.clear();
		this.calls.length = 0;
		this.failOn = null;
	}
}

/** The folder: `<dir>/<id>.json`, its files in `<dir>/<id>/`. A key that would land outside `dir` is refused too. */
export function folderBackend(dir: string): Backend {
	const root = resolve(dir);
	const pathOf = (key: string) => {
		const target = resolve(root, ...key.split('/'));
		if (!target.startsWith(root + sep)) throw new Error(`submissions: a key outside the store: ${key}`);
		return target;
	};
	const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
	return {
		async put(key, body) {
			const file = pathOf(key);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, body);
		},
		async get(key) {
			try {
				return new Uint8Array(await readFile(pathOf(key)));
			} catch (error) {
				if (missing(error)) return null;
				throw error;
			}
		},
		async remove(key) {
			await unlink(pathOf(key)).catch((error: unknown) => {
				if (!missing(error)) throw error;
			});
		},
		async ids() {
			try {
				return (await readdir(root)).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
			} catch (error) {
				if (missing(error)) return [];
				throw error;
			}
		},
		async removeFolder(id) {
			await rmdir(join(root, id)).catch(() => {});
		},
	};
}

export interface SubmissionsBucket {
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
}

const S3_TIMEOUT_MS = 20_000;

/** The submissions bucket over S3's REST API, signed with aws4fetch (as the media bucket is), path-style. */
export function bucketBackend(settings: SubmissionsBucket, fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)): Backend {
	const client = new AwsClient({ accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey, service: 's3', region: settings.region });
	const base = `${settings.endpoint}/${encodeURIComponent(settings.bucket)}`;
	const url = (key: string) => `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
	const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
	async function call(method: string, target: string, init: { headers?: Record<string, string>; body?: Uint8Array } = {}) {
		const request = await client.sign(target, { method, headers: { 'X-Amz-Content-Sha256': init.body ? createHash('sha256').update(init.body).digest('hex') : EMPTY, ...init.headers }, body: init.body as BodyInit | undefined });
		return fetchImpl(request, { signal: AbortSignal.timeout(S3_TIMEOUT_MS) });
	}
	const refused = async (what: string, res: Response) => new Error(`submissions bucket: ${what}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
	return {
		async put(key, body, contentType) {
			const res = await call('PUT', url(key), { headers: { 'Content-Type': contentType }, body });
			if (!res.ok) throw await refused(`put ${key}`, res);
			await res.body?.cancel().catch(() => {});
		},
		async get(key) {
			const res = await call('GET', url(key));
			if (res.status === 404) {
				await res.body?.cancel().catch(() => {});
				return null;
			}
			if (!res.ok) throw await refused(`get ${key}`, res);
			return new Uint8Array(await res.arrayBuffer());
		},
		async remove(key) {
			const res = await call('DELETE', url(key));
			if (!res.ok && res.status !== 404) throw await refused(`delete ${key}`, res);
			await res.body?.cancel().catch(() => {});
		},
		async ids() {
			// `delimiter=/`: a submission's files come back as one CommonPrefix each, never as keys.
			const ids: string[] = [];
			let token: string | null = null;
			for (let page = 0; page < 1000; page++) {
				const query = new URLSearchParams({ 'list-type': '2', delimiter: '/' });
				if (token) query.set('continuation-token', token);
				const res = await call('GET', `${base}?${query}`);
				const text = await res.text();
				if (!res.ok) throw new Error(`submissions bucket: list: ${res.status} ${text.slice(0, 300)}`);
				for (const m of text.matchAll(/<Contents>[\s\S]*?<Key>([^<]*)<\/Key>[\s\S]*?<\/Contents>/g)) {
					const key = m[1]!.replace(/&amp;/g, '&');
					if (!key.includes('/') && key.endsWith('.json')) ids.push(key.slice(0, -5));
				}
				const next = /<IsTruncated>true<\/IsTruncated>/.test(text) ? (/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(text)?.[1] ?? null) : null;
				if (!next || next === token) break;
				token = next;
			}
			return ids;
		},
	};
}

// ── The store over a backend ─────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const jsonKey = (id: string) => `${id}.json`;

export function storeOver(backend: Backend, options: { removeFolder?: boolean; notSpam?: boolean } = {}): SubmissionStore {
	/** Unread ids, built on first use (`unreadCount`), then kept by every write here. */
	let unread: Promise<Set<string>> | null = null;
	const track = (fn: (set: Set<string>) => void) => {
		// A rejection handler on the chain: if the first listing fails, `unreadCount` resets and rethrows to
		// its own caller; this chain must not also end unhandled. The count rebuilds on the next read.
		if (unread) {
			const next = unread.then((set) => (fn(set), set));
			next.catch(() => {});
			unread = next;
		}
	};

	async function get(id: string): Promise<StoredSubmission | null> {
		if (!isSubmissionId(id)) return null;
		const body = await backend.get(jsonKey(id));
		if (!body) return null;
		const value = JSON.parse(decoder.decode(body)) as StoredSubmission;
		return value && typeof value === 'object' && value.id === id ? value : null;
	}
	const put = (record: StoredSubmission) => backend.put(jsonKey(record.id), encoder.encode(`${JSON.stringify(record, null, 2)}\n`), 'application/json');
	/** Remove every key, each tried; throws the first failure after. */
	async function removeAll(keys: string[]) {
		let failure: unknown = null;
		for (const key of keys) {
			try {
				await backend.remove(key);
			} catch (error) {
				failure ??= error;
			}
		}
		if (failure) throw failure;
	}
	/** Read a list of ids, a few at a time. A submission deleted meanwhile is skipped. */
	async function readAll(ids: string[]): Promise<StoredSubmission[]> {
		const out: (StoredSubmission | null)[] = new Array(ids.length).fill(null);
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(16, ids.length) }, async () => {
				while (next < ids.length) {
					const i = next++;
					out[i] = await get(ids[i]!);
				}
			}),
		);
		return out.filter((s): s is StoredSubmission => s !== null);
	}

	/**
	 * The memory store's "Not spam" (tests seed a flagged one straight into the backend): the
	 * flag and the held email go, as the cloud answers while it sends. Nothing is sent here.
	 */
	async function notSpam(id: string): Promise<StoredSubmission | null> {
		const current = await get(id);
		if (!current?.spam) return current;
		const { spam: _spam, email: _email, ...rest } = current;
		await put(rest);
		return rest;
	}

	return {
		...(options.notSpam ? { notSpam } : {}),
		async create({ form, receivedAt, fields, files }) {
			const id = newSubmissionId(receivedAt);
			const stored: StoredFile[] = (files ?? []).map((f, i) => ({ name: f.name, size: f.data.byteLength, type: f.type, key: fileKey(id, i + 1, f.name) }));
			const record: StoredSubmission = { v: 1, id, form, receivedAt, fields, ...(stored.length ? { files: stored } : {}), readAt: null };
			const written: string[] = [];
			try {
				// Files first, then the JSON: a submission is never listed with a file missing.
				for (const [i, file] of stored.entries()) {
					await backend.put(file.key, files![i]!.data, 'application/octet-stream');
					written.push(file.key);
				}
				await put(record);
			} catch (error) {
				// Nothing is kept: what was written goes (best effort; the first failure is the one reported).
				await removeAll(written).catch(() => {});
				if (stored.length && options.removeFolder !== false) await backend.removeFolder?.(id).catch(() => {});
				throw error;
			}
			track((set) => set.add(id));
			return record;
		},
		get,
		async getFile(id, n) {
			const record = await get(id);
			const file = Number.isInteger(n) && n >= 1 ? record?.files?.[n - 1] : undefined;
			// Checked against the id asked for, not the JSON's own: a tampered key is never read.
			if (!record || !file || !isFileKey(id, file.key)) return null;
			const body = await backend.get(file.key);
			return body ? { file, body } : null;
		},
		async list(opts = {}) {
			const limit = Math.max(1, Math.min(500, opts.limit ?? PAGE_SIZE));
			const sorted = (await backend.ids()).filter(isSubmissionId).sort().reverse();
			const after = opts.before ? sorted.filter((id) => id < opts.before!) : sorted;
			const page = after.slice(0, limit);
			return { items: await readAll(page), older: after.length > limit ? page[page.length - 1]! : null };
		},
		async update(id, patch) {
			const current = await get(id);
			if (!current) return null;
			const next: StoredSubmission = { ...current, ...patch, id: current.id, v: current.v };
			await put(next);
			track((set) => (next.readAt === null ? set.add(id) : set.delete(id)));
			return next;
		},
		async delete(id) {
			const record = await get(id);
			if (!record) return false;
			const keys = (record.files ?? []).map((f) => f.key).filter((key) => isFileKey(id, key));
			// The files first: a failure stops here, the submission (the way to its files) still listed.
			await removeAll(keys);
			await backend.remove(jsonKey(id));
			track((set) => set.delete(id));
			if (keys.length) await backend.removeFolder?.(id).catch(() => {});
			return true;
		},
		async unreadCount() {
			unread ??= (async () => {
				const all = await readAll((await backend.ids()).filter(isSubmissionId));
				return new Set(all.filter((s) => s.readAt === null).map((s) => s.id));
			})().catch((error: unknown) => {
				unread = null;
				throw error;
			});
			return (await unread).size;
		},
	};
}

// ── Which store ──────────────────────────────────────────────────────────────

export type SubmissionsConfig =
	| { kind: 'memory' }
	| { kind: 'folder'; dir: string }
	| { kind: 'bucket'; bucket: SubmissionsBucket }
	/** CaraCMS Cloud (caracms-cloud M4 Decision 23): a production server with `CARACMS_CLOUD_KEY`. */
	| { kind: 'cloud'; connection: { key: string; url: string } }
	/** The production server without its bucket: `message` names what's missing (the endpoint's log, the inbox's sentence). */
	| { kind: 'unset'; message: string; missing: string[] };

const list = (names: readonly string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** Whether this is a production server, for the store: `NODE_ENV=production` (Decision 7). */
export const isProductionEnv = (env: Env): boolean => env['NODE_ENV'] === 'production';

/** Decision 7's rule, from the environment. Read on each call (cheap). */
export function readSubmissionsConfig(root: string, env: Env = process.env, production = isProductionEnv(env), services: Services | null = bakedServices()): SubmissionsConfig {
	// caracms-cloud M5 Decision 2: with the config's `services`, the other mode's variables are never read.
	env = servicesEnv(env, services);
	const get = (name: string) => env[name]?.trim() || '';
	const mode = get('CARACMS_SUBMISSIONS');
	if (mode === 'memory') return production ? { kind: 'unset', message: SUBMISSIONS_MEMORY_IN_PRODUCTION, missing: [] } : { kind: 'memory' };
	if (mode) return { kind: 'unset', message: `CARACMS_SUBMISSIONS must be "memory" or unset (got "${mode}").`, missing: [] };
	// The key with the site's own variables is a mistake everywhere (M4 Decision 22), as the media's is.
	const cloud = cloudForms(env, services);
	if (cloud?.problems.length) return { kind: 'unset', message: cloud.problems.join(' '), missing: [] };
	// Outside production: the folder, even with the cloud key (M4's Core framing).
	if (!production) return { kind: 'folder', dir: join(root, LOCAL_SUBMISSIONS_FOLDER) };
	if (cloud) return { kind: 'cloud', connection: cloud.connection };
	// M5 Decision 4: a cloud site without its key, never the site's own bucket instead.
	if (services === 'cloud') return { kind: 'unset', message: CLOUD_KEY_MISSING_PROBLEM, missing: ['CARACMS_CLOUD_KEY'] };
	const missing = [...SUBMISSIONS_ENV, ...SHARED_ENV].filter((name) => !get(name));
	if (missing.length) {
		return {
			kind: 'unset',
			message: `Form submissions aren't set up on this server: set CARACMS_CLOUD_KEY to the site's CaraCMS Cloud key, or set ${list(missing)} to the site's submissions bucket.`,
			missing,
		};
	}
	return {
		kind: 'bucket',
		bucket: {
			bucket: get('SUBMISSIONS_S3_BUCKET'),
			endpoint: get('S3_ENDPOINT').replace(/\/+$/, ''),
			region: get('S3_REGION'),
			accessKeyId: get('SUBMISSIONS_S3_ACCESS_KEY_ID'),
			secretAccessKey: get('SUBMISSIONS_S3_SECRET_ACCESS_KEY'),
		},
	};
}

const SHARED = Symbol.for('caracms.submissions');
type Shared = { [SHARED]?: { stores: Map<string, SubmissionStore>; memory: MemoryBackend } };
const shared = () => ((globalThis as Shared)[SHARED] ??= { stores: new Map(), memory: new MemoryBackend() });

/** The in-memory backend behind `CARACMS_SUBMISSIONS=memory`, one per process (tests seed and inspect it). */
export const memorySubmissions = (): MemoryBackend => shared().memory;

/** Forget every store and empty the memory backend (tests). */
export function resetSubmissions(): void {
	const s = shared();
	s.stores.clear();
	s.memory.clear();
}

/** The store for this config, one per process per backend (so the unread count is kept), or the `unset` config itself. */
export function submissionStore(config: SubmissionsConfig, fetchImpl?: typeof fetch): SubmissionStore | Extract<SubmissionsConfig, { kind: 'unset' }> {
	if (config.kind === 'unset') return config;
	// One per call (a request): the cloud keeps the unread count, and the store holds only the count its own last answer gave.
	if (config.kind === 'cloud') return cloudStore({ ...config.connection, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
	const s = shared();
	const id = config.kind === 'memory' ? 'memory' : config.kind === 'folder' ? `folder:${config.dir}` : `bucket:${config.bucket.endpoint}:${config.bucket.bucket}:${config.bucket.accessKeyId}`;
	let store = s.stores.get(id);
	if (!store) {
		const backend = config.kind === 'memory' ? s.memory : config.kind === 'folder' ? folderBackend(config.dir) : bucketBackend(config.bucket, fetchImpl);
		store = storeOver(backend, { notSpam: config.kind === 'memory' });
		s.stores.set(id, store);
	}
	return store;
}
