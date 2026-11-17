/**
 * The sign-in pages' HTML (M4 Phase 3; M2 mockup `packages/caracms/test/mockups/m2-editor.html` →
 * `signinHTML` and `narrowHTML`, whose markup, classes and copy these follow; M2
 * Decision 17's quoted copy is the template's and is kept word for word).
 *
 * Plain server-rendered HTML with **no editor bundle**: one stylesheet (the editor's
 * tokens plus the mockup's sign-in rules below) and, on the pages that need it, one
 * fixed script (`SIGNIN_SCRIPT`) for the confirm and backup presses and the narrow
 * note's Copy. Both are inline and allowed by their hashes in the page's CSP.
 * **Requesting a link is a plain form POST** and needs no script.
 *
 * Branded with the site's slots (name, accent with its computed ink and edge, logo,
 * icon), and laid out down to 320 wide.
 */
import { createHash } from 'node:crypto';
import { DEFAULT_NEXT, LOGIN_PATH, loginHref } from './session.ts';

// ── Escaping ──────────────────────────────────────────────────────────────────

export class SafeHtml {
	readonly value: string;
	constructor(value: string) {
		this.value = value;
	}
	toString() {
		return this.value;
	}
}
const escapeHtml =(s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const part = (v: unknown): string => (v instanceof SafeHtml ? v.value : Array.isArray(v) ? v.map(part).join('') : v === null || v === undefined || v === false ? '' : escapeHtml(String(v)));
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
	let out = strings[0]!;
	values.forEach((v, i) => (out += part(v) + strings[i + 1]!));
	return new SafeHtml(out);
}

// ── Icons (the editor's sprite paths, inline) ──────────────────────────────────

const ICONS: Record<string, string> = {
	check: '<path d="m3 8.5 3.2 3L13 4.5"/>',
	warn: '<path d="M8 2 14.8 13.6H1.2z"/><path d="M8 6.3v3.4M8 11.6v.1"/>',
	ext: '<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4"/>',
	copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
};
const ic = (name: string, size = '') => new SafeHtml(`<svg class="i${size ? ` ${size}` : ''}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`);

// ── The stylesheet ─────────────────────────────────────────────────────────────

/**
 * The sign-in rules: the editor's base and components the pages use (editor.css),
 * then the mockup's sign-in and narrow-note sections, its `@container app` queries
 * as media queries (the page is the whole window here), with the restyle's pressed
 * edges and frames (the editor restyle).
 */
export const LOGIN_CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{font:var(--weight-regular) var(--text-base)/var(--leading) var(--font-ui);color:var(--text);background:var(--surface-sunken);-webkit-font-smoothing:antialiased}
button,input{font:inherit;color:inherit;letter-spacing:inherit}
button{cursor:pointer}
p{margin:0}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.i{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.i-sm{width:14px;height:14px}.i-xs{width:12px;height:12px}
.field-label{font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--text)}
.input{display:block;width:100%;min-height:var(--control-h);padding:6px 10px;border:1px solid var(--border-strong);border-radius:var(--radius-md);background:var(--surface);font-size:var(--text-base);line-height:1.4;transition:border-color var(--dur-fast),box-shadow var(--dur-fast)}
.input:hover:not(:disabled){border-color:var(--border-hover)}
.input:focus{outline:none;border-color:var(--select);box-shadow:0 0 0 3px var(--select-halo)}
.field-err{display:flex;align-items:flex-start;gap:var(--space-1-5);margin-top:var(--space-1-5);font-size:var(--text-sm);color:var(--status-danger);font-weight:var(--weight-medium)}
.field-err .i{margin-top:2px}
.linkbtn{display:inline-flex;align-items:center;gap:var(--space-1);padding:0;border:0;background:none;color:var(--select-strong);font-weight:var(--weight-medium);text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 40%,transparent);text-underline-offset:3px}
.linkbtn:hover{text-decoration-color:currentColor}
.linkbtn.subtle{color:var(--text-muted);text-decoration:none}
.linkbtn.subtle:hover{color:var(--text)}
.linkbtn.subtle:active{background:var(--surface-pressed)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-1-5);height:var(--control-h);padding:0 var(--space-3);border:1px solid var(--border-strong);border-radius:var(--radius-md);background:var(--surface);color:var(--text);font-size:var(--text-base);font-weight:var(--weight-semibold);white-space:nowrap;box-shadow:var(--shadow-control);text-decoration:none;transition:background var(--dur-fast),border-color var(--dur-fast),filter var(--dur-fast),translate var(--dur-fast),box-shadow var(--dur-fast)}
.btn:hover:not(:disabled){background:var(--surface-hover);border-color:var(--border-hover)}
.btn:active:not(:disabled){translate:0 var(--press-depth);box-shadow:0 0 0 var(--edge-secondary)}
.btn.sm{height:var(--control-h-sm);padding:0 var(--space-2-5);font-size:var(--text-sm)}
.btn.block{width:100%}
.btn.accent{background:var(--accent);border-color:var(--accent-edge);color:var(--accent-ink);box-shadow:0 var(--press-depth) 0 var(--edge-accent)}
.btn.accent:hover:not(:disabled){background:var(--accent);border-color:var(--accent-edge);filter:brightness(.93)}
.btn.accent:active:not(:disabled){box-shadow:0 0 0 var(--edge-accent)}
.btn:disabled{background:var(--surface-sunken);border-color:var(--border);color:var(--text-subtle);box-shadow:none;cursor:not-allowed;filter:none;translate:none}
.si-logo{width:28px;height:28px;flex:none}
.si-logo img{display:block;width:100%;height:100%;object-fit:contain}
.logo-mono{display:grid;place-items:center;width:100%;height:100%;border-radius:var(--radius-md);background:var(--accent);color:var(--accent-ink);box-shadow:inset 0 0 0 1px var(--accent-edge);font:var(--weight-bold) var(--text-lg)/1 var(--font-ui)}
.si{min-height:100vh;display:flex;flex-direction:column}
.si-bar{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);height:56px;padding:0 var(--space-5);background:var(--surface);border-bottom:1px solid var(--border)}
.si-brand{display:flex;align-items:center;gap:var(--space-2-5);min-width:0;font-weight:var(--weight-semibold);font-size:var(--text-md)}
.si-brand .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.si-brand .sub{color:var(--text-muted);font-weight:var(--weight-regular);white-space:nowrap}
.si-home{display:inline-flex;align-items:center;gap:var(--space-1);color:var(--text-muted);font-size:var(--text-sm);text-decoration:none;white-space:nowrap}
.si-home:hover{color:var(--text)}
.si-main{flex:1;display:flex;flex-direction:column;align-items:center;padding:clamp(28px,9vh,96px) var(--space-4) var(--space-10)}
.si-card{width:100%;max-width:400px;padding:var(--space-8);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-xl);box-shadow:var(--shadow-edge)}
.si-card h1{margin:0 0 var(--space-2);font-size:var(--text-2xl);font-weight:var(--weight-semibold);letter-spacing:var(--tracking-tight);line-height:1.2;overflow-wrap:anywhere}
.si-card .sub{color:var(--text-muted);margin-bottom:var(--space-5)}
.si-card p{color:var(--text-muted)}
.si-card p strong{color:var(--text);font-weight:var(--weight-semibold);overflow-wrap:anywhere}
.si-card form{margin:0}
.si-card .field{margin:0 0 var(--space-4)}
.si-card .field label{display:block;margin-bottom:var(--space-1-5)}
.si-card .input{min-height:42px;font-size:var(--text-md)}
.si-card .input[aria-invalid="true"]{border-color:var(--frame-danger);box-shadow:var(--shadow-hard-danger);border-width:var(--frame-width)}
.si-card .input[aria-invalid="true"]:focus{border-color:var(--status-danger);box-shadow:0 0 0 3px var(--status-danger-halo),var(--shadow-hard-danger)}
.si-card .btn{height:42px;font-size:var(--text-md)}
.si-card .fine{margin-top:var(--space-4);font-size:var(--text-sm);color:var(--text-muted)}
.si-card .who{margin:var(--space-2) 0 var(--space-4);padding:var(--space-3);border-radius:var(--radius-md);background:var(--surface-sunken);color:var(--text-muted);overflow-wrap:anywhere}
.si-card .row-acts{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-3);margin-top:var(--space-5)}
.si-card .row-acts form{display:contents}
.si-card .notice{display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-5);padding:var(--space-2) var(--space-3);border-radius:var(--radius-md);font-size:var(--text-sm);font-weight:var(--weight-medium)}
.si-card .notice[hidden]{display:none}
.si-card .notice.info{background:var(--surface-sunken);border:1px solid var(--border);color:var(--text)}
.si-card .notice.ok{background:var(--status-live-wash);border:1px solid var(--status-live-border);color:var(--status-live)}
.si-card .notice.fail{background:var(--status-danger-wash);border:var(--frame-width) solid var(--frame-danger);color:var(--status-danger);box-shadow:var(--shadow-hard-danger)}
.si-card .dead-act{margin-top:var(--space-5)}
.si-alt{margin-top:var(--space-4);font-size:var(--text-sm)}
.si-alt .linkbtn{color:var(--text-muted)}
.si-alt .linkbtn:hover{color:var(--text)}
.noscript{margin-bottom:var(--space-4);font-size:var(--text-sm);color:var(--status-danger)}
@media (max-width:440px){
  .si-bar{padding:0 var(--space-4)}
  .si-brand .sub{display:none}
  .si-card{padding:var(--space-6) var(--space-5)}
  .si-card h1{font-size:var(--text-xl)}
}
.nw{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:var(--space-8) var(--space-5)}
.nw-in{width:100%;max-width:420px}
.nw-brand{display:flex;align-items:center;gap:var(--space-2-5);margin-bottom:var(--space-8);font-weight:var(--weight-semibold);font-size:var(--text-md)}
.nw h1{margin:0 0 var(--space-3);font-size:var(--text-2xl);font-weight:var(--weight-semibold);letter-spacing:var(--tracking-tight);line-height:1.2}
.nw p{color:var(--text-muted);font-size:var(--text-md)}
.nw p+p{margin-top:var(--space-3)}
.nw .addr{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);margin-top:var(--space-5);padding:var(--space-2) var(--space-2) var(--space-2) var(--space-3);border:1px solid var(--border-strong);border-radius:var(--radius-md);background:var(--surface);font-family:var(--font-mono);font-size:var(--text-sm);overflow-wrap:anywhere}
.nw .ok{display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-5);padding:var(--space-2) var(--space-3);border:1px solid var(--status-live-border);border-radius:var(--radius-md);background:var(--status-live-wash);color:var(--status-live);font-size:var(--text-sm);font-weight:var(--weight-medium);overflow-wrap:anywhere}
.nw .fine{margin-top:var(--space-6);font-size:var(--text-sm)}
.nw form{margin:0}
`;

// ── The script ────────────────────────────────────────────────────────────────

export const SIGNIN_PATH = `${LOGIN_PATH}/signin`;
export const SIGNED_IN_PATH = `${LOGIN_PATH}/signed-in`;

/**
 * The presses (the template's SIGNIN_SCRIPT, minus Auth.js): one fixed block, no
 * interpolation, so its hash is fixed. It reads the kind and `next` from the form's
 * `data-signin` / `data-next` and the link token from the page's own URL, never the
 * markup. It POSTs JSON to /admin/login/signin and goes where the answer says, or to
 * the signed-in note when the window is under 1024 wide (M2 Decision 8). A dead link
 * reloads the confirm page, whose read-only check then shows the dead-link page; the
 * backup form shows the wrong-password or too-many message. A second press is ignored.
 * It also does the narrow note's Copy.
 */
export const SIGNIN_SCRIPT = `
(() => {
  const copy = document.querySelector("[data-copy]");
  if (copy) copy.addEventListener("click", () => {
    const text = location.protocol + "//" + copy.getAttribute("data-copy");
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => { const l = copy.querySelector("span"); if (l) l.textContent = "Copied"; });
  });
  const form = document.querySelector("form[data-signin]");
  if (!form) return;
  const kind = form.getAttribute("data-signin");
  const next = form.getAttribute("data-next") || "/admin";
  const button = form.querySelector("button[type=submit]");
  const error = document.getElementById("signin-error");
  const idle = button ? button.textContent : "";
  const messages = {
    wrong: "That username and password didn't work.",
    limited: "Too many attempts. Try again in 15 minutes.",
    failed: "Couldn't sign in. Try again."
  };
  let busy = false;
  const setBusy = (on) => {
    busy = on;
    if (!button) return;
    button.disabled = on;
    button.setAttribute("aria-busy", on ? "true" : "false");
    button.textContent = on ? "Signing in\\u2026" : idle;
  };
  const fail = (reason) => {
    if (kind === "link" && reason === "dead-link") { location.reload(); return; }
    setBusy(false);
    if (error) { error.textContent = messages[reason] || messages.failed; error.hidden = false; }
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    if (error) error.hidden = true;
    const body = { kind: kind, next: next };
    if (kind === "link") body.token = new URLSearchParams(location.search).get("token") || "";
    else { body.username = form.elements.namedItem("username").value; body.password = form.elements.namedItem("password").value; }
    try {
      const res = await fetch("${SIGNIN_PATH}", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (res.ok && data && typeof data.location === "string" && data.location.charAt(0) === "/" && data.location.charAt(1) !== "/") {
        const narrow = window.matchMedia("(max-width: 1023px)").matches;
        location.assign(narrow ? "${SIGNED_IN_PATH}?next=" + encodeURIComponent(data.location) : data.location);
        return;
      }
      fail(data && data.reason);
    } catch (e) {
      fail("failed");
    }
  });
})();
`;

const sha256b64 = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64');

// ── The layout ────────────────────────────────────────────────────────────────

export interface Brand {
	name: string;
	accent: string;
	accentInk: string;
	accentEdge: string;
	logo?: string;
	icon: string;
}

export interface PageAssets {
	/** The editor's tokens (styles/tokens.css), as text. */
	tokensCss: string;
	/** `@font-face` rules for the chrome's face, with their URLs, or ''. */
	fontsCss: string;
}

export interface RenderedPage {
	html: string;
	csp: string;
}

/** The images a page may load: its own origin, plus the logo's and icon's if elsewhere. */
function imageSources(brand: Brand): string[] {
	const out = new Set(["'self'", 'data:']);
	for (const url of [brand.logo, brand.icon]) {
		if (!url || url.startsWith('/') || url.startsWith('data:')) continue;
		try {
			const { protocol, origin } = new URL(url);
			if (protocol === 'https:' || protocol === 'http:') out.add(origin);
		} catch {
			/* not a URL: never loaded */
		}
	}
	return [...out];
}

function brandMark(brand: Brand): SafeHtml {
	if (brand.logo) return html`<img src="${brand.logo}" alt="">`;
	const initial = [...brand.name.trim()][0]?.toLocaleUpperCase() ?? '';
	return html`<span class="logo-mono" aria-hidden="true">${initial}</span>`;
}

/**
 * The whole page. `quiet` drops the bar's link back to the public site, so nothing
 * competes with the one button (the confirm and switch views, as in the mockup).
 */
export function layout(input: { title: string; brand: Brand; assets: PageAssets; body: SafeHtml; script?: boolean; quiet?: boolean; home?: string; bare?: boolean }): RenderedPage {
	const { brand, assets } = input;
	const accent = `:root{--accent:${brand.accent};--accent-ink:${brand.accentInk};--accent-edge:${brand.accentEdge}}`;
	const css = `${assets.fontsCss}\n${assets.tokensCss}\n${LOGIN_CSS}\n${accent}`;
	const bar = input.bare
		? ''
		: html`<header class="si-bar"><span class="si-brand"><span class="si-logo">${brandMark(brand)}</span><span class="nm">${brand.name}</span><span class="sub">· Sign in</span></span>${
				input.quiet || !input.home ? '' : html`<a class="si-home" href="/">${input.home}${ic('ext', 'i-xs')}</a>`
			}</header>`;
	const main = input.bare ? input.body : html`<div class="si">${bar}<main class="si-main">${input.body}</main></div>`;
	const page = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${input.title} · ${brand.name}</title>
<link rel="icon" href="${brand.icon}">
<style>${new SafeHtml(css)}</style>
</head>
<body>
${main}
${input.script ? html`<script>${new SafeHtml(SIGNIN_SCRIPT)}</script>` : ''}
</body>
</html>
`;
	const csp = [
		"default-src 'none'",
		`style-src 'sha256-${sha256b64(css)}'`,
		`script-src ${input.script ? `'sha256-${sha256b64(SIGNIN_SCRIPT)}'` : "'none'"}`,
		"connect-src 'self'",
		`img-src ${imageSources(brand).join(' ')}`,
		"font-src 'self'",
		"form-action 'self'",
		"base-uri 'none'",
		"frame-ancestors 'none'",
	].join('; ');
	return { html: page.value, csp };
}

// ── The views ─────────────────────────────────────────────────────────────────

const NOSCRIPT = html`<noscript><p class="noscript">Signing in needs JavaScript. Turn it on and reload this page.</p></noscript>`;
const FINE = html`<p class="fine">Not you? Close this tab.</p>`;

const backupLink = (next: string) => html`<p class="si-alt"><a class="linkbtn" href="${loginHref({ backup: '1' }, next)}">Use the backup account</a></p>`;

/** The email form: plain, signed out, or with the malformed-address error. */
export function emailView(input: { next: string; value?: string; invalid?: string; signedOut?: boolean; backupEnabled: boolean; notice?: string | null }): SafeHtml {
	const bad = !!input.invalid;
	return html`<section class="si-card">${addressNoticeHtml(input.notice)}${input.signedOut ? html`<p class="notice info" role="status">${ic('check', 'i-sm')}You're signed out.</p>` : ''}<h1>Sign in</h1><p class="sub">We'll email you a sign-in link.</p><form method="post" action="${LOGIN_PATH}" novalidate><input type="hidden" name="next" value="${input.next}"><div class="field"><label class="field-label" for="si-email">Email address</label><input class="input" id="si-email" name="email" type="email" autocomplete="email" inputmode="email" spellcheck="false" autofocus value="${input.value ?? ''}"${new SafeHtml(bad ? ' aria-invalid="true" aria-describedby="si-err"' : '')}>${
		bad ? html`<p class="field-err" id="si-err">${ic('warn', 'i-sm')}<span>${input.invalid}</span></p>` : ''
	}</div><button class="btn accent block" type="submit">Send sign-in link</button></form></section>${input.backupEnabled ? backupLink(input.next) : ''}`;
}

/**
 * **"Check your email": the same page on every path** (allowed, unknown,
 * rate-limited, send failed). It repeats the address typed, which the person already
 * knows, and says nothing about it.
 */
/**
 * caracms-cloud adversarial review, editor wording note (B3): the same answer for every
 * address, so it never says whether one has access; this line tells someone who mistyped
 * theirs, or wasn't invited, why nothing may come.
 */
export const SENT_BY_INVITATION = 'Sign-in is by invitation. If nothing arrives in a few minutes, check the address or ask whoever invited you.';

export function sentView(input: { email: string; next: string; again: boolean; backupEnabled: boolean }): SafeHtml {
	return html`<section class="si-card">${input.again ? html`<p class="notice ok" role="status">${ic('check', 'i-sm')}Sent again.</p>` : ''}<h1>Check your email</h1><p>If <strong>${input.email}</strong> can sign in, a link is on its way. It expires in 15 minutes.</p><p class="fine">${SENT_BY_INVITATION}</p><p class="fine">Not there? Check spam, or send again.</p><div class="row-acts"><form method="post" action="${LOGIN_PATH}"><input type="hidden" name="email" value="${input.email}"><input type="hidden" name="next" value="${input.next}"><input type="hidden" name="again" value="1"><button class="btn" type="submit">Send again</button></form><a class="linkbtn" href="${loginHref({}, input.next)}">Use a different address</a></div></section>${input.backupEnabled ? backupLink(input.next) : ''}`;
}

/** Runs-anywhere Decision 7: the site was opened at an address that isn't its own (request.ts → `addressNotice`). */
function addressNoticeHtml(notice: string | null | undefined): SafeHtml | string {
	return notice ? html`<p class="notice fail" role="alert" data-notice="address">${ic('warn', 'i-sm')}${notice}</p>` : '';
}

/** The backup form. Posting it without script only shows it again. */
export function backupView(input: { next: string; notice?: string | null }): SafeHtml {
	return html`<section class="si-card">${addressNoticeHtml(input.notice)}<p class="notice fail" id="signin-error" role="alert" hidden></p><h1>Backup account</h1><p class="sub">Details are in the shared password manager.</p>${NOSCRIPT}<form method="post" action="${loginHref({ backup: '1' }, input.next)}" data-signin="backup" data-next="${input.next}"><div class="field"><label class="field-label" for="si-user">Username</label><input class="input" id="si-user" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" autofocus required></div><div class="field"><label class="field-label" for="si-pass">Password</label><input class="input" id="si-pass" name="password" type="password" autocomplete="current-password" required></div><button class="btn accent block" type="submit">Sign in</button></form></section><p class="si-alt"><a class="linkbtn" href="${loginHref({}, input.next)}">Use email sign-in instead</a></p>`;
}

/**
 * "Sign in as …", or **"Switch to …?"** when this browser is signed in as someone else.
 * The form has no action: without script it posts back to this URL, which only
 * redirects to the GET. Nothing is spent until the press.
 */
export function confirmView(input: { email: string; next: string; siteName: string; current: string | null }): SafeHtml {
	const site = `the ${input.siteName} website`;
	const head = input.current
		? html`<h1>Switch to ${input.email}?</h1><p class="sub">Signed in here as <strong>${input.current}</strong>. Signing in replaces that.</p>`
		: html`<h1>Sign in to ${site}</h1>`;
	return html`<section class="si-card"><p class="notice fail" id="signin-error" role="alert" hidden></p>${head}${NOSCRIPT}<form method="post" data-signin="link" data-next="${input.next}"><p class="who">Sign in as <strong>${input.email}</strong></p><button class="btn accent block" type="submit">Sign in</button></form>${FINE}</section>`;
}

/** **Expired, used, unknown and missing tokens: one page**, with "Send a new link". */
export function deadLinkView(): SafeHtml {
	return html`<section class="si-card"><h1>This link has expired or was already used</h1><p>Ask for a new one.</p><a class="btn accent block dead-act" href="${LOGIN_PATH}">Send a new link</a></section>`;
}

/**
 * After signing in on a phone (M2 Decision 8, the mockup's "Below 1024, just signed in
 * on a phone"): signed in, open the editor on a larger screen. With Sign out.
 */
export function signedInNarrowView(input: { brand: Brand; who: string; host: string }): SafeHtml {
	const address = `${input.host}${DEFAULT_NEXT}`;
	return html`<div class="nw"><div class="nw-in"><div class="nw-brand"><span class="si-logo">${brandMark(input.brand)}</span>${input.brand.name}</div><p class="ok">${ic('check', 'i-sm')}You're signed in as ${input.who}.</p><h1>Open the editor on a bigger screen</h1><p>The editor needs a window at least 1,024 pixels wide.</p><p>On a laptop or desktop, go to:</p><div class="addr"><span>${address}</span><button type="button" class="btn sm" data-copy="${address}">${ic('copy', 'i-sm')}<span>Copy</span></button></div><form class="fine" method="post" action="${LOGIN_PATH}/signout"><button type="submit" class="linkbtn subtle">Sign out</button></form></div></div>`;
}

/** Anything else: a heading, a sentence and the way back. */
export function messageView(heading: string, text: string): SafeHtml {
	return html`<section class="si-card"><h1>${heading}</h1><p class="sub">${text}</p><p class="si-alt"><a class="linkbtn" href="${LOGIN_PATH}">Back to sign in</a></p></section>`;
}
