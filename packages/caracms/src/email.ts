/**
 * The package's one email sender (M6 Decision 8): Resend's REST API through plain
 * `fetch`, from `FORMS_FROM` with `RESEND_API_KEY`, both trimmed (a trailing newline in
 * a sender address once broke an agency's form email for three days). The sign-in
 * link (live/auth/email.ts) and the form's notification (forms/email.ts) both send
 * through it.
 *
 * It only sends. **Whether to send is the caller's**: both send only on a production
 * server (`NODE_ENV=production`) and log everywhere else, so no test from a laptop
 * reaches anyone's inbox. It never throws: an unset key or sender, Resend's refusal
 * or a timeout all come back as a result with a sentence.
 */
import { bakedServices, servicesEnv } from './live/services.ts';

export const RESEND_URL = 'https://api.resend.com/emails';
export const SEND_TIMEOUT_MS = 10_000;

export type SendResult = { status: 'sent' } | { status: 'skipped' | 'failed'; error: string };

export interface Email {
	to: string[];
	subject: string;
	text: string;
	html?: string;
	replyTo?: string;
}

/** Whether this process sends email at all: only a production server does. */
export const sendsEmail = (env: Record<string, string | undefined>): boolean => env['NODE_ENV'] === 'production';

export async function sendEmail(
	email: Email,
	options: { env?: Record<string, string | undefined>; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<SendResult> {
	// caracms-cloud M5 Decision 2: on a cloud site RESEND_API_KEY and FORMS_FROM are never read (the cloud sends).
	const env = servicesEnv(options.env ?? process.env, bakedServices());
	const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
	const apiKey = (env['RESEND_API_KEY'] ?? '').trim();
	const from = (env['FORMS_FROM'] ?? '').trim();
	const unset = [!apiKey && 'RESEND_API_KEY', !from && 'FORMS_FROM'].filter(Boolean);
	if (unset.length) return { status: 'skipped', error: `${unset.join(' and ')} not set, so no email was sent.` };

	const body: Record<string, unknown> = { from, to: email.to, subject: email.subject, text: email.text };
	if (email.html) body.html = email.html;
	if (email.replyTo) body.reply_to = email.replyTo;
	try {
		const res = await (options.fetch ?? fetch)(RESEND_URL, {
			method: 'POST',
			headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (res.ok) {
			await res.body?.cancel().catch(() => {});
			return { status: 'sent' };
		}
		let detail = '';
		try {
			const json = (await res.json()) as { message?: string; name?: string };
			detail = json?.message || json?.name || '';
		} catch {
			/* not JSON */
		}
		return { status: 'failed', error: `Resend answered ${res.status}${detail ? `: ${detail}` : ''}` };
	} catch (error) {
		const name = (error as { name?: string } | null)?.name;
		if (name === 'TimeoutError' || name === 'AbortError') return { status: 'failed', error: `Resend didn't answer within ${Math.round(timeoutMs / 1000)} s.` };
		return { status: 'failed', error: `Could not reach Resend: ${error instanceof Error ? error.message : String(error)}` };
	}
}
