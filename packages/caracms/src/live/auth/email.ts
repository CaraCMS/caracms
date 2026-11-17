/**
 * The sign-in link email, and the one place that decides whether it's emailed or
 * logged (M4 Decision 14; the template's `server/login-email.mjs`).
 *
 * **Only when `NODE_ENV` is `production`** is it sent, through Resend
 * (`RESEND_API_KEY`) from `FORMS_FROM`. Everywhere else the link is printed to the
 * server log and nothing is sent, so no test from a laptop reaches anyone's inbox.
 * The email names the site by its brand name. The link carries only the token.
 *
 * **On CaraCMS Cloud** (caracms-cloud M4 Decision 25), a production server with
 * `CARACMS_CLOUD_KEY` asks the cloud instead (`POST /v1/email/sign-in`), which writes the
 * email from its own copy of this template and sends it from `accounts.caracms.com`. The
 * key beside `RESEND_API_KEY` or `FORMS_FROM` (Decision 22) sends nothing and logs why.
 * Outside production the link is logged, key or not.
 *
 * The HTML part is one table layout with inline styles (mail clients strip `<style>`),
 * the system font stack, no images; the plain-text part says the same.
 */
import { sendEmail, sendsEmail } from '../../email.ts';
import { cloudCall, isCloudRefusal } from '../cloud.ts';
import { cloudForms } from '../mode.ts';

export { RESEND_URL } from '../../email.ts';
const FONT = "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function buildLinkEmail({ siteName, link, email }: { siteName: string; link: string; email: string }): { subject: string; text: string; html: string } {
	const site = siteName.trim();
	const subject = site ? `Sign in to the ${site} website` : 'Sign in to the website';
	const button = site ? `Sign in to ${site}` : 'Sign in';
	const expiry = 'The link expires in 15 minutes and works once.';
	const ignore = "Didn't ask for this? Ignore it.";
	const text = [subject, '', `Open this link and press "Sign in" to sign in as ${email}:`, '', link, '', expiry, '', ignore, ''].join('\n');
	const href = escapeHtml(link);
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f2;font-family:${FONT};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border:1px solid #e3e3de;border-radius:10px;">
<tr><td style="padding:28px 28px 8px;font-family:${FONT};font-size:20px;line-height:1.3;font-weight:600;color:#1b1b19;">${escapeHtml(subject)}</td></tr>
<tr><td style="padding:0 28px 20px;font-family:${FONT};font-size:15px;line-height:1.5;color:#1b1b19;">Sign in as <strong>${escapeHtml(email)}</strong>.</td></tr>
<tr><td style="padding:0 28px 20px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#1b1b19;border-radius:6px;">
<a href="${href}" style="display:inline-block;padding:13px 22px;font-family:${FONT};font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(button)}</a>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 28px 8px;font-family:${FONT};font-size:13px;line-height:1.5;color:#5e5e58;">${escapeHtml(expiry)}</td></tr>
<tr><td style="padding:0 28px 24px;font-family:${FONT};font-size:13px;line-height:1.5;color:#5e5e58;">${escapeHtml(ignore)}</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #e3e3de;font-family:${FONT};font-size:12px;line-height:1.5;color:#5e5e58;word-break:break-all;">Button not working? Paste this into your browser:<br><a href="${href}" style="color:#1b1b19;">${href}</a></td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
	return { subject, text, html };
}

export type Delivery = 'sent' | 'logged' | 'failed';

/**
 * Email the link in production, log it everywhere else. Never throws: a Resend failure
 * is logged, and the page never says whether a link went out. The sending is the
 * package's one sender (../../email.ts, M6 Decision 8).
 */
export async function deliverLink(input: {
	to: string;
	link: string;
	siteName: string;
	env: Record<string, string | undefined>;
	log: (line: string) => void;
	fetch?: typeof fetch;
}): Promise<Delivery> {
	const { to, link, siteName, env, log } = input;
	if (!sendsEmail(env)) {
		log(`sign-in link for ${to} (not emailed outside production): ${link}`);
		return 'logged';
	}
	const cloud = cloudForms(env);
	if (cloud) {
		if (cloud.problems.length) {
			log(`could not email a sign-in link: ${cloud.problems.join(' ')}`);
			return 'failed';
		}
		try {
			await cloudCall({ ...cloud.connection, ...(input.fetch ? { fetch: input.fetch } : {}) }, 'POST', '/v1/email/sign-in', { to, link, siteName });
			return 'sent';
		} catch (error) {
			log(`could not email a sign-in link: CaraCMS Cloud${isCloudRefusal(error) ? ` (${error.error}): ${error.message}` : `: ${error instanceof Error ? error.message : String(error)}`}`);
			return 'failed';
		}
	}
	const { subject, text, html } = buildLinkEmail({ siteName, link, email: to });
	const result = await sendEmail({ to: [to], subject, text, html }, { env, fetch: input.fetch });
	if (result.status === 'sent') return 'sent';
	log(`could not email a sign-in link: ${result.error}`);
	return 'failed';
}
