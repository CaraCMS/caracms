/**
 * GitHub's webhook, `POST /_caracms/github` (M4 Decisions 8 and 14). It takes no
 * session; it checks GitHub's signature instead.
 *
 * - **No `GITHUB_WEBHOOK_SECRET`: 404**, as if the route didn't exist; the
 *   once-a-minute check does the job.
 * - **`X-Hub-Signature-256` must be the body's HMAC-SHA256 under the secret**,
 *   compared in constant time, or it's 401 and nothing happens.
 * - **Nothing in the body is trusted or even read**: a good signature only prompts
 *   Decision 8's check, which asks GitHub itself what moved.
 * - **At most 25 MB is read**, counted as it comes (body.ts): a chunked body with no
 *   `Content-Length`, or one that lies, is refused at the cap, not after (finding 10).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readCapped } from '../body.ts';

/** Largest body read. GitHub caps payloads at 25 MB; a push is far smaller, and it's never parsed. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export function signatureMatches(secret: string, body: Buffer, header: string | null): boolean {
	if (!header || !header.startsWith('sha256=')) return false;
	const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
	const given = Buffer.from(header.trim());
	return given.length === expected.length && timingSafeEqual(given, expected);
}

const text = (status: number, body: string) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

/**
 * The whole route. `trigger` starts the check and isn't awaited: GitHub wants an
 * answer within ten seconds, and a merge can take longer.
 */
export async function handleGithubWebhook(request: Request, options: { secret: string | null; trigger: () => Promise<unknown> }): Promise<Response> {
	if (!options.secret) return text(404, 'Not found');
	if (request.method !== 'POST') return new Response('The webhook only takes POST.', { status: 405, headers: { Allow: 'POST' } });
	// caracms-cloud adversarial review, finding 10: the bytes are counted as they're read and the read
	// stops at the cap, with or without a Content-Length, before the signature is checked.
	const read = await readCapped(request, MAX_BODY_BYTES);
	if (!read.ok) return text(413, 'Too large.');
	const body = Buffer.from(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength);
	if (!signatureMatches(options.secret, body, request.headers.get('x-hub-signature-256'))) return text(401, 'Bad signature.');
	void options.trigger().catch((error: unknown) => console.error('[caracms] the check after a webhook failed:', error));
	return text(202, 'Checking.');
}
