/**
 * The public form's one small script (M6 Decision 17), on a page with a form only
 * (Form.astro carries it). It enhances a form that already works without it:
 *
 * - submits with `fetch` (`Accept: application/json`), shows "Sending…", then the
 *   thanks line, or the endpoint's own sentence when it gave one (the thanks and the
 *   failure lines are the form's `data-thanks` / `data-failed` when Form.astro was given them);
 * - makes a files field's picks add up: each pick is added to the files already chosen
 *   (the real list kept in a `DataTransfer` and given back to `input.files`, so the fetch
 *   and a plain submit both send every one), the same name and size never twice, listed
 *   under the input with each one's size and a Remove button. A pick that would pass a
 *   limit (5 files, 25 MB in all, the kinds) adds nothing past it and says the endpoint's
 *   own sentence in the status line;
 * - checks the chosen files against the limits before sending (the endpoint checks
 *   them again; this only spares a visitor a refused upload);
 * - turns `?sent=1` (the no-JS reply) into the thanks line and drops it from the address;
 * - review gaps (Decisions 9 and 12): its words are the form's (`data-sending`, `data-thanks`,
 *   `data-failed`: Site Settings', the site code's or the package's); with a sent heading the
 *   form gives way to its sent panel (`[data-caracms-form-sent]`) in place of the thanks line;
 *   and on an editor's preview page it does nothing (the form never sends or checks itself there);
 * - renders the Turnstile widget when the form has a site key (api.js loaded once,
 *   explicit render), and mints a fresh token after each send.
 *
 * Astro inlines this script only while it stays under Vite's inline limit (4096 bytes built; it's
 * about 4080), which the starter's build-output tests hold it to. So a rows field's Add, Remove,
 * numbering and narrowing are form-rows-client.ts, which Form.astro carries only on a form with a
 * rows field (form rows Decision 12).
 *
 * A port of the template's Form section script (`forms.md` → The Form section). If
 * anything here throws before `preventDefault`, the form is still a working native post.
 */

const THANKS = "Thanks, we'll be in touch shortly.";
const FAILED = 'Something went wrong. Please email us directly.';
const SENDING = 'Sending…';
/** The editor's preview page (types.ts → PREVIEW_MARK). */
const PREVIEW_MARK = 'data-caracms-preview';

interface Turnstile {
	render: (el: HTMLElement, opts: Record<string, unknown>) => string;
	reset: (container?: string | HTMLElement) => void;
}
type TurnstileWindow = Window & { turnstile?: Turnstile; __caracmsTurnstile?: () => void };
const turnstile = () => (window as TurnstileWindow).turnstile;

let apiJs: Promise<void> | undefined;
function loadTurnstile(): Promise<void> {
	if (turnstile()) return Promise.resolve();
	apiJs ??= new Promise((resolve) => {
		(window as TurnstileWindow).__caracmsTurnstile = resolve;
		const s = document.createElement('script');
		s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__caracmsTurnstile&render=explicit';
		s.async = true;
		document.head.appendChild(s);
	});
	return apiJs;
}

/** Why the chosen files can't be sent, or ''. */
function filesProblem(form: HTMLFormElement): string {
	const maxFiles = Number(form.dataset.maxFiles);
	const maxBytes = Number(form.dataset.maxBytes);
	if (!maxFiles || !maxBytes) return '';
	const files = [...form.querySelectorAll<HTMLInputElement>('input[type="file"]')].flatMap((input) => [...(input.files ?? [])]);
	if (files.length > maxFiles) return `Attach up to ${maxFiles} files (you chose ${files.length}).`;
	const bytes = files.reduce((sum, file) => sum + file.size, 0);
	if (bytes > maxBytes) return `That's too much to send: attachments can come to ${Math.round(maxBytes / 1024 / 1024)} MB in all. Send fewer or smaller files, or email them to us.`;
	return '';
}

// No `<` here: the page's check reads this inline script as text with no `<` in it (build-output tests).
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

/** A files field's picks add up, listed with Remove (see above). Without `DataTransfer`, it stays the native input. */
function enhanceFiles(form: HTMLFormElement, say: (text: string, failed: boolean) => void): void {
	const input = form.querySelector<HTMLInputElement>('input[type="file"]');
	const list = form.querySelector<HTMLUListElement>('[data-caracms-files]');
	if (!input || !list || typeof DataTransfer !== 'function') return;
	const maxFiles = Number(form.dataset.maxFiles);
	const maxBytes = Number(form.dataset.maxBytes);
	const exts = input.accept.split(',').map((e) => e.trim().replace(/^\./, '').toLowerCase());
	let chosen: File[] = [];
	const sync = () => {
		const dt = new DataTransfer();
		for (const f of chosen) dt.items.add(f);
		input.files = dt.files;
		list.replaceChildren(
			...chosen.map((f, i) => {
				const li = document.createElement('li');
				li.className = 'cms-form-file';
				const name = document.createElement('span');
				name.className = 'cms-form-file-name';
				name.textContent = f.name;
				const bytes = document.createElement('span');
				bytes.className = 'cms-form-file-size';
				bytes.textContent = size(f.size);
				const remove = document.createElement('button');
				remove.type = 'button';
				remove.className = 'cms-form-file-remove';
				remove.textContent = 'Remove';
				remove.setAttribute('aria-label', `Remove ${f.name}`);
				remove.addEventListener('click', () => {
					chosen = chosen.filter((_, j) => j !== i);
					sync();
					(list.querySelectorAll<HTMLButtonElement>('.cms-form-file-remove')[Math.min(i, chosen.length - 1)] ?? input).focus();
				});
				li.append(name, ' ', bytes, ' ', remove);
				return li;
			}),
		);
		list.hidden = chosen.length === 0;
	};
	input.addEventListener('change', () => {
		const picked = [...(input.files ?? [])].filter((f) => !chosen.some((c) => c.name === f.name && c.size === f.size));
		const next = [...chosen];
		let problem = '';
		for (const f of picked) {
			const ext = /\.([^.]+)$/.exec(f.name)?.[1]?.toLowerCase() ?? '';
			if (!exts.includes(ext)) problem ||= `${f.name}: we can't take that kind of file. Send ${form.dataset.fileKinds} files.`;
			else if (next.length >= maxFiles) problem ||= `Attach up to ${maxFiles} files (you chose ${chosen.length + picked.length}).`;
			else if (next.reduce((sum, x) => sum + x.size, f.size) > maxBytes) problem ||= `That's too much to send: attachments can come to ${Math.round(maxBytes / 1024 / 1024)} MB in all. Send fewer or smaller files, or email them to us.`;
			else next.push(f);
		}
		chosen = next;
		sync();
		say(problem, !!problem);
	});
	form.addEventListener('reset', () => {
		chosen = [];
		// After the reset has emptied the input.
		setTimeout(sync);
	});
}

function enhance(form: HTMLFormElement): void {
	if (form.dataset.caracmsFormReady) return;
	form.dataset.caracmsFormReady = '1';
	const status = form.querySelector<HTMLElement>('[data-caracms-form-status]');
	if (!status) return;
	const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
	const widget = form.querySelector<HTMLElement>('[data-caracms-turnstile]');
	const thanks = form.dataset.thanks || THANKS;
	const failedLine = form.dataset.failed || FAILED;
	const sending = form.dataset.sending || SENDING;
	const say = (text: string, failed: boolean) => {
		status.textContent = text;
		status.classList.toggle('cms-form-failed', failed);
	};
	// A sent heading: the form gives way to its sent panel; without one, the thanks line in the status line.
	const panel = form.querySelector<HTMLElement>('[data-caracms-form-sent]');
	const sent = () => {
		if (!panel) return say(thanks, false);
		for (const child of form.children) if (child !== panel && child instanceof HTMLElement) child.hidden = true;
		panel.hidden = false;
	};

	enhanceFiles(form, say);

	if (widget?.dataset.sitekey) {
		const sitekey = widget.dataset.sitekey;
		void loadTurnstile().then(() => turnstile()?.render(widget, { sitekey, appearance: 'always', theme: 'light' }));
	}

	form.addEventListener('submit', async (event) => {
		if (!form.reportValidity()) return;
		event.preventDefault();
		const tooMuch = filesProblem(form);
		if (tooMuch) return say(tooMuch, true);
		submit?.setAttribute('disabled', '');
		say(sending, false);
		let failure = failedLine;
		try {
			const res = await fetch(form.action, { method: 'POST', headers: { Accept: 'application/json' }, body: new FormData(form) });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
				if (typeof body?.error === 'string' && body.error && res.status !== 502) failure = body.error;
				throw new Error(String(res.status));
			}
			form.reset();
			sent();
		} catch {
			say(failure, true);
		} finally {
			submit?.removeAttribute('disabled');
			// Turnstile's tokens are single-use: a fresh one for the next send.
			if (widget) turnstile()?.reset(widget);
		}
	});

	// The no-JS path lands back here with ?sent=1.
	const params = new URLSearchParams(location.search);
	if (params.get('sent') === '1') {
		sent();
		params.delete('sent');
		const rest = params.toString();
		history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
	}
}

export function initForms(): void {
	if (document.documentElement.hasAttribute(PREVIEW_MARK)) return;
	for (const form of document.querySelectorAll<HTMLFormElement>('form[data-caracms-form]')) enhance(form);
}
