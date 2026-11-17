/**
 * The submissions store on CaraCMS Cloud (caracms-cloud M4 Decisions 5–9 and 23), behind
 * store.ts's `SubmissionStore`, so the endpoint's checks and the inbox don't change. The
 * site's server never holds R2 or Resend credentials: it asks the API (live/cloud.ts, the
 * site key), which answers for the site's own folder.
 *
 * - `create`: mints the id (`newSubmissionId`, the package's own shape), builds the
 *   `StoredSubmission`, asks the `email` callback to write the email for it, and sends both
 *   (`POST /v1/submissions`). On `409 exists` it mints a new id, writes the email again (its
 *   link names the id) and tries once more. With files, the answer is **pending** with one
 *   presigned PUT per file: each is uploaded with exactly the headers named, then
 *   `POST /v1/submissions/confirm`, tried once more on a timeout or an unreachable cloud.
 *   An upload that fails, or a confirm answered `409 incomplete`, removes the row
 *   (`POST /v1/submissions/delete`); a confirm that never got through is left to the
 *   cloud's hourly clean-up. Either way `create` throws: the visitor gets the endpoint's 502.
 * - `get`, `list`, `update` (`readAt` only), `delete`, `getFile` (a 5-minute download
 *   URL, then the bytes) and `notSpam` (the spam check's flag gone, its held email sent):
 *   one route each.
 * - **The unread count comes back with every answer**; `unreadCount()` gives the last one
 *   this store saw, or asks (`GET /v1/submissions/unread`). store.ts makes a store per
 *   request, so the count is never older than the request.
 *
 * Refusals are `CloudRefusal`s with the cloud's own sentence (the endpoint logs it, the
 * inbox shows it). Presigned URLs go nowhere but the fetch here: never in a log line or an error.
 */
import { createHash } from 'node:crypto';
import { cloudCall, CloudRefusal, isCloudRefusal, type CloudConnection } from '../live/cloud.ts';
import { isSubmissionId } from './rules.ts';
import { fileKey, isFileKey, newSubmissionId, PAGE_SIZE, type StoredFile, type StoredSubmission, type SubmissionStore } from './store.ts';

const STORAGE_TIMEOUT_MS = 20_000;

const malformed = (what: string) => new CloudRefusal('unreachable', `CaraCMS Cloud's answer to ${what} isn't one the package knows.`);

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** A submission as the cloud answered it: the package's own shape, checked enough to be read by the inbox. */
function submissionOf(value: unknown, what: string): StoredSubmission {
	const s = value as StoredSubmission | null;
	if (!s || typeof s !== 'object' || !isSubmissionId(s.id) || typeof s.form !== 'string' || typeof s.receivedAt !== 'string' || !s.fields || typeof s.fields !== 'object') {
		throw malformed(what);
	}
	const { filesNote, spam, ...rest } = s;
	// The attachments-not-kept sentence (caracms-cloud's attachment limit): kept only as a non-empty string.
	const note = typeof filesNote === 'string' && filesNote.trim() ? { filesNote: filesNote.trim() } : {};
	// The spam check's flag (email feedback, 2026-11-11): kept only as an object with a string `at`, and only that.
	const flagged = spam && typeof spam === 'object' && typeof (spam as { at?: unknown }).at === 'string' ? { spam: { at: (spam as { at: string }).at } } : {};
	return { ...rest, v: 1, readAt: typeof s.readAt === 'string' ? s.readAt : null, ...note, ...flagged };
}

export function cloudStore(connection: CloudConnection): SubmissionStore {
	const fetchImpl = connection.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
	/** The unread count from the last answer that carried one. */
	let unread: number | null = null;
	const seen = (answer: Record<string, unknown>) => {
		const n = count(answer.unread);
		if (n !== null) unread = n;
	};
	const api = (method: 'GET' | 'POST', path: string, body?: unknown) => cloudCall(connection, method, path, body);
	/** Null for the cloud's `404 not_found`; any other refusal goes up as sent. */
	async function orNull(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown> | null> {
		try {
			return await api(method, path, body);
		} catch (error) {
			if (isCloudRefusal(error) && error.error === 'not_found') return null;
			throw error;
		}
	}

	/** A presigned URL's request, with its own timeout. */
	async function storage(what: string, url: string, init: RequestInit): Promise<Response> {
		try {
			return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS) });
		} catch (error) {
			throw new Error(`submissions: ${what}: storage unreachable (${error instanceof Error ? error.message : String(error)})`);
		}
	}

	/** The confirm, tried once more when the cloud didn't answer (Decision 6). */
	async function confirm(id: string): Promise<void> {
		for (let attempt = 1; ; attempt++) {
			try {
				await api('POST', '/v1/submissions/confirm', { id });
				return;
			} catch (error) {
				if (attempt < 2 && isCloudRefusal(error) && error.error === 'unreachable') continue;
				throw error;
			}
		}
	}

	/** The row goes, best effort: the cloud's hourly clean-up takes it otherwise. */
	const discard = (id: string) => api('POST', '/v1/submissions/delete', { id }).catch(() => {});

	async function get(id: string): Promise<StoredSubmission | null> {
		if (!isSubmissionId(id)) return null;
		const answer = await orNull('GET', `/v1/submissions/get?${new URLSearchParams({ id })}`);
		if (!answer) return null;
		seen(answer);
		const submission = submissionOf(answer.submission, 'get');
		return submission.id === id ? submission : null;
	}

	return {
		sendsEmail: true,
		async create({ form, receivedAt, fields, files, email }) {
			const hashes = (files ?? []).map((f) => createHash('sha256').update(f.data).digest('hex'));
			for (let attempt = 1; ; attempt++) {
				const id = newSubmissionId(receivedAt);
				const stored: StoredFile[] = (files ?? []).map((f, i) => ({ name: f.name, size: f.data.byteLength, type: f.type, key: fileKey(id, i + 1, f.name) }));
				const record: StoredSubmission = { v: 1, id, form, receivedAt, fields, ...(stored.length ? { files: stored } : {}), readAt: null };
				const written = email?.(record) ?? { emailSkipped: 'No email was written for this submission.' };
				let answer: Record<string, unknown>;
				try {
					answer = await api('POST', '/v1/submissions', {
						id,
						form,
						receivedAt,
						fields,
						...(stored.length ? { files: stored.map((f, i) => ({ name: f.name, type: f.type, size: f.size, key: f.key, sha256: hashes[i] })) } : {}),
						...written,
					});
				} catch (error) {
					// The id was already the site's (Decision 5): a new one, and the email written again for it.
					if (attempt < 2 && isCloudRefusal(error) && error.error === 'exists') continue;
					throw error;
				}
				if (answer.state === 'complete') return record;
				if (answer.state !== 'pending' || !Array.isArray(answer.uploads)) throw malformed('a new submission');
				try {
					for (const file of stored) {
						const upload = (answer.uploads as Record<string, unknown>[]).find((u) => u && typeof u === 'object' && u.key === file.key);
						const { url, method, headers } = upload ?? {};
						if (typeof url !== 'string' || !/^https?:\/\//.test(url) || (method !== undefined && method !== 'PUT') || !headers || typeof headers !== 'object') {
							throw malformed('a new submission');
						}
						// The headers as the cloud named them (the URL signs each); Content-Length and Host are fetch's own.
						const sent = Object.fromEntries(
							Object.entries(headers as Record<string, unknown>).filter(([name, v]) => typeof v === 'string' && !/^(content-length|host)$/i.test(name)),
						) as Record<string, string>;
						const n = stored.indexOf(file);
						const res = await storage(`upload ${n + 1}`, url, { method: 'PUT', headers: sent, body: files![n]!.data as BodyInit });
						await res.body?.cancel().catch(() => {});
						// 412: the signed If-None-Match: * found the key already there, so an earlier try put it.
						if (!res.ok && res.status !== 412) throw new Error(`submissions: upload ${n + 1} of ${stored.length}: the storage answered ${res.status}`);
					}
				} catch (error) {
					await discard(id);
					throw error;
				}
				try {
					await confirm(id);
				} catch (error) {
					// `409 incomplete`: a file isn't there at its size, so the row goes. Unreachable: the cloud's clean-up takes it.
					if (isCloudRefusal(error) && error.error !== 'unreachable') await discard(id);
					throw error;
				}
				return record;
			}
		},
		get,
		async getFile(id, n) {
			if (!isSubmissionId(id) || !Number.isInteger(n) || n < 1) return null;
			const answer = await orNull('POST', '/v1/submissions/file-url', { id, n });
			if (!answer) return null;
			const file = answer.file as StoredFile | undefined;
			// Checked against the id asked for: a key that isn't this submission's is never read.
			if (typeof answer.url !== 'string' || !file || typeof file !== 'object' || !isFileKey(id, file.key)) throw malformed('a file');
			const res = await storage(`download ${n}`, answer.url, { method: 'GET' });
			if (res.status === 404) {
				await res.body?.cancel().catch(() => {});
				return null;
			}
			if (!res.ok) {
				await res.body?.cancel().catch(() => {});
				throw new Error(`submissions: download ${n}: the storage answered ${res.status}`);
			}
			return { file: { name: String(file.name ?? ''), size: Number(file.size) || 0, type: String(file.type ?? ''), key: file.key }, body: new Uint8Array(await res.arrayBuffer()) };
		},
		async list(opts = {}) {
			const limit = Math.max(1, Math.min(500, opts.limit ?? PAGE_SIZE));
			const query = new URLSearchParams({ limit: String(limit) });
			if (opts.before) {
				// The cloud refuses a cursor not of the id's shape; v3's stores treat it as "after everything".
				if (!isSubmissionId(opts.before)) return { items: [], older: null };
				query.set('before', opts.before);
			}
			const answer = await api('GET', `/v1/submissions?${query}`);
			if (!Array.isArray(answer.items)) throw malformed('the list');
			seen(answer);
			const older = answer.older;
			return { items: answer.items.map((s) => submissionOf(s, 'the list')), older: typeof older === 'string' && isSubmissionId(older) ? older : null };
		},
		async update(id, patch) {
			// The cloud records the email's outcome itself; only `readAt` is the inbox's to change.
			if (!('readAt' in patch)) return get(id);
			if (!isSubmissionId(id)) return null;
			const answer = await orNull('POST', '/v1/submissions/update', { id, readAt: patch.readAt ?? null });
			if (!answer) return null;
			seen(answer);
			return submissionOf(answer.submission, 'an update');
		},
		async delete(id) {
			if (!isSubmissionId(id)) return false;
			const answer = await api('POST', '/v1/submissions/delete', { id });
			seen(answer);
			return answer.deleted === true;
		},
		async notSpam(id) {
			if (!isSubmissionId(id)) return null;
			const answer = await orNull('POST', '/v1/submissions/not-spam', { id });
			if (!answer) return null;
			seen(answer);
			// The submission as `get` answers it (`{ submission, unread }`), or bare, as caracms-cloud 3718e34 answers.
			const submission = submissionOf(answer.submission && typeof answer.submission === 'object' ? answer.submission : answer, '"not spam"');
			return submission.id === id ? submission : null;
		},
		async unreadCount() {
			if (unread !== null) return unread;
			const answer = await api('GET', '/v1/submissions/unread');
			const n = count(answer.unread);
			if (n === null) throw malformed('the unread count');
			unread = n;
			return n;
		},
	};
}
