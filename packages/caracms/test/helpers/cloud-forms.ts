/**
 * A stand-in for CaraCMS Cloud's forms and email routes (caracms-cloud M4 → Contracts) and
 * the attachments bucket's presigned URLs, as one `fetch`. Rows are kept the way the spec
 * keeps them (pending until confirmed, never listed while pending, the unread count on
 * the site), so the cloud store's tests run v3's store cases against it.
 */
import { createHash } from 'node:crypto';
import { isFileKey } from '../../src/forms/store.ts';
import { isSubmissionId } from '../../src/forms/rules.ts';
import type { StoredSubmission } from '../../src/forms/store.ts';

export const CLOUD_URL = 'https://cloud.test';
export const CLOUD_KEY = `cck_${'a'.repeat(43)}`;
const R2 = 'https://r2.test';
const FOLDER = 'sites/site-a/';

interface Row {
	submission: StoredSubmission;
	state: 'pending' | 'complete';
	/** The email as sent: `{ email }`, `{ emailSkipped }` or `{ emailFailed }`. */
	written: Record<string, unknown>;
	sha256: string[];
}

export interface FakeCloud {
	fetch: typeof fetch;
	rows: Map<string, Row>;
	/** The bucket: `sites/site-a/<key>` → bytes. */
	r2: Map<string, Uint8Array>;
	/** Every call, as `METHOD path` (the query left off) or `PUT r2:<key>` / `GET r2:<key>`. */
	calls: string[];
	/** Each JSON body the API got, by route. */
	bodies: { route: string; body: Record<string, unknown> }[];
	/** Sign-in emails asked for. */
	signIns: Record<string, unknown>[];
	/** Answer the next N creates `409 exists`. */
	existsNext: number;
	/** "Not spam" answers its email held with this sentence (the site over its daily limit), instead of sending. */
	notSpamHolds?: string;
	/** Make a call fail: return a Response to answer it with, or 'throw' for a network failure. */
	failOn: ((call: string) => Response | 'throw' | null) | null;
}

/** The cloud's rule for a field's value (`cloud/convex/lib/forms.ts` → fieldValueProblem): text, or a list of flat text rows. */
const cloudFieldValueOk = (value: unknown): boolean =>
	typeof value === 'string' ||
	(Array.isArray(value) &&
		value.length <= 50 &&
		value.every((row) => row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length <= 20 && Object.entries(row as Record<string, unknown>).every(([k, v]) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(k) && typeof v === 'string')));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const refuse = (status: number, error: string, message = `Refused: ${error}.`) => json(status, { error, message });

export function fakeCloud(): FakeCloud {
	const cloud: FakeCloud = { rows: new Map(), r2: new Map(), calls: [], bodies: [], signIns: [], existsNext: 0, failOn: null, fetch: null! };
	const unread = () => [...cloud.rows.values()].filter((r) => r.state === 'complete' && r.submission.readAt === null).length;
	const complete = (id: unknown) => {
		const row = typeof id === 'string' ? cloud.rows.get(id) : undefined;
		return row?.state === 'complete' ? row : null;
	};

	cloud.fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.origin === R2) {
			const key = decodeURIComponent(url.pathname.slice(1));
			const call = `${request.method} r2:${key}`;
			cloud.calls.push(call);
			const fail = cloud.failOn?.(call);
			if (fail === 'throw') throw new TypeError('fetch failed');
			if (fail) return fail;
			if (request.method === 'PUT') {
				if (request.headers.get('if-none-match') === '*' && cloud.r2.has(key)) return new Response(null, { status: 412 });
				const body = new Uint8Array(await request.arrayBuffer());
				if (createHash('sha256').update(body).digest('hex') !== request.headers.get('x-amz-content-sha256')) return new Response('bad hash', { status: 400 });
				cloud.r2.set(key, body);
				return new Response(null, { status: 200 });
			}
			const body = cloud.r2.get(key);
			return body ? new Response(body as BodyInit, { status: 200 }) : new Response('NoSuchKey', { status: 404 });
		}
		if (url.origin !== CLOUD_URL) throw new Error(`fake cloud: an unexpected fetch to ${url.origin}`);
		const call = `${request.method} ${url.pathname}`;
		cloud.calls.push(call);
		const fail = cloud.failOn?.(call);
		if (fail === 'throw') throw new TypeError('fetch failed');
		if (fail) return fail;
		if (request.headers.get('authorization') !== `Bearer ${CLOUD_KEY}`) return refuse(401, 'unknown_key');
		const body = request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : {};
		if (request.method === 'POST') cloud.bodies.push({ route: url.pathname, body });
		const q = url.searchParams;

		switch (call) {
			case 'POST /v1/submissions': {
				const id = body.id;
				if (typeof id !== 'string' || !isSubmissionId(id)) return refuse(400, 'bad_id');
				if (cloud.existsNext > 0) {
					cloud.existsNext--;
					return refuse(409, 'exists');
				}
				if (cloud.rows.has(id)) return refuse(409, 'exists');
				// Form rows (Contracts → The cloud): a field's value is text, or a list of at most 50 flat rows of at most 20 text cells.
				if (!body.fields || typeof body.fields !== 'object' || Object.values(body.fields).some((v) => !cloudFieldValueOk(v))) return refuse(400, 'bad_request');
				const writtenKeys = ['email', 'emailSkipped', 'emailFailed'].filter((k) => body[k] !== undefined);
				if (writtenKeys.length !== 1) return refuse(400, 'bad_request');
				const files = (body.files as { name: string; type: string; size: number; key: string; sha256: string }[] | undefined) ?? [];
				if (files.some((f) => !isFileKey(id, f.key))) return refuse(400, 'bad_key');
				const submission: StoredSubmission = {
					v: 1,
					id,
					form: body.form as string,
					receivedAt: body.receivedAt as string,
					fields: body.fields as StoredSubmission['fields'],
					...(files.length ? { files: files.map(({ name, size, type, key }) => ({ name, size, type, key })) } : {}),
					readAt: null,
				};
				cloud.rows.set(id, { submission, state: files.length ? 'pending' : 'complete', written: { [writtenKeys[0]!]: body[writtenKeys[0]!] }, sha256: files.map((f) => f.sha256) });
				if (!files.length) return json(200, { id, state: 'complete' });
				return json(200, {
					id,
					state: 'pending',
					uploads: files.map((f) => ({
						key: f.key,
						url: `${R2}/${FOLDER}${f.key.split('/').map(encodeURIComponent).join('/')}?X-Amz-Signature=fake`,
						method: 'PUT',
						headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(f.size), 'x-amz-content-sha256': f.sha256, 'If-None-Match': '*' },
						expiresAt: new Date(Date.now() + 300_000).toISOString(),
					})),
				});
			}
			case 'POST /v1/submissions/confirm': {
				const row = typeof body.id === 'string' ? cloud.rows.get(body.id) : undefined;
				if (!row) return refuse(404, 'not_found');
				if (row.state === 'pending') {
					const missing = (row.submission.files ?? []).some((f) => cloud.r2.get(`${FOLDER}${f.key}`)?.byteLength !== f.size);
					if (missing) return refuse(409, 'incomplete');
					row.state = 'complete';
				}
				return json(200, { id: row.submission.id, state: 'complete' });
			}
			case 'GET /v1/submissions': {
				const before = q.get('before');
				if (before !== null && !isSubmissionId(before)) return refuse(400, 'bad_id');
				const limit = Math.max(1, Math.min(500, Number(q.get('limit') ?? 50) || 50));
				const all = [...cloud.rows.values()].filter((r) => r.state === 'complete').map((r) => r.submission).sort((a, b) => (a.id < b.id ? 1 : -1));
				const after = before ? all.filter((s) => s.id < before) : all;
				const page = after.slice(0, limit);
				return json(200, { items: page, older: after.length > limit ? page[page.length - 1]!.id : null, unread: unread() });
			}
			case 'GET /v1/submissions/get': {
				const row = complete(q.get('id'));
				return row ? json(200, { submission: row.submission, unread: unread() }) : refuse(404, 'not_found');
			}
			case 'POST /v1/submissions/update': {
				const row = complete(body.id);
				if (!row) return refuse(404, 'not_found');
				row.submission = { ...row.submission, readAt: (body.readAt as string | null) ?? null };
				return json(200, { submission: row.submission, unread: unread() });
			}
			case 'POST /v1/submissions/delete': {
				const row = typeof body.id === 'string' ? cloud.rows.get(body.id) : undefined;
				if (!row) return json(200, { deleted: false, unread: unread() });
				for (const f of row.submission.files ?? []) cloud.r2.delete(`${FOLDER}${f.key}`);
				cloud.rows.delete(row.submission.id);
				return json(200, { deleted: true, unread: unread() });
			}
			case 'POST /v1/submissions/file-url': {
				const row = complete(body.id);
				const file = row && typeof body.n === 'number' ? row.submission.files?.[body.n - 1] : undefined;
				if (!file) return refuse(404, 'not_found');
				return json(200, { url: `${R2}/${FOLDER}${file.key.split('/').map(encodeURIComponent).join('/')}?X-Amz-Signature=fake`, expiresAt: new Date(Date.now() + 300_000).toISOString(), file });
			}
			case 'POST /v1/submissions/not-spam': {
				// As the cloud answers, shaped like `get` (`{ submission, unread }`): the submission with its flag
				// gone and its email absent while it sends (`held` when the site's emails can't go out:
				// `notSpamHolds`). Unflagged: unchanged.
				const row = complete(body.id);
				if (!row) return refuse(404, 'not_found');
				if (row.submission.spam) {
					const { spam: _spam, email, ...rest } = row.submission;
					row.submission = cloud.notSpamHolds && email ? { ...rest, email: { ...email, status: 'held', error: cloud.notSpamHolds } } : rest;
				}
				return json(200, { submission: row.submission, unread: unread() });
			}
			case 'GET /v1/submissions/unread':
				return json(200, { unread: unread() });
			case 'POST /v1/email/sign-in': {
				if (typeof body.to !== 'string' || typeof body.link !== 'string' || !/^https:\/\//.test(body.link)) return refuse(400, 'bad_request');
				cloud.signIns.push(body);
				return json(202, { ok: true });
			}
		}
		return refuse(404, 'not_found', `No route ${call}.`);
	};
	return cloud;
}
