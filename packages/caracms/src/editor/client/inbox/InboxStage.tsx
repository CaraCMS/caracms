/**
 * The stage under the inbox (M6 Decision 9; the mockup's #submission, #submission-failed,
 * #submission-skipped, #submission-unknown): the last page stays, dimmed (shell/Stage.tsx),
 * and a submission opens over it on a light sheet, with the list kept in the sidebar.
 *
 * The sheet: the form and the full time in the site's zone, who sent it and their address,
 * **Reply by email** (a `mailto:` with the address percent-encoded and the subject
 * "Re: your enquiry to <brand>"), **Mark unread** (which closes it: staying open would be
 * reading it again), **Delete…** (after a confirm: documents/dialogs.tsx); then the email's
 * outcome (sent to whom, failed with Resend's message, skipped and why, held behind a cloud
 * site's daily limit with the cloud's sentence, or unknown; possibly spam, with **Not spam,
 * send it**, and then sending while the cloud sends it), and
 * every field by its label, files as downloads with their sizes.
 *
 * **Visitor strings are only ever text** (React's escaping): no `dangerouslySetInnerHTML`
 * on this path. Files always download (`download`, and the route's `Content-Disposition:
 * attachment`).
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { plainRowLines, rowsLines, senderName, shownChoice, shownFileName, type ResolvedFormField } from '../../../forms/rules.ts';
import { useEditor, useStore } from '../context.tsx';
import { openDialog } from '../documents/dialogs.tsx';
import { Icon } from '../shell/Icons.tsx';
import type { Editor } from '../editor.ts';
import type { EmailOutcome, StoredSubmission, SubmissionResponse } from '../../types.ts';
import { ENDPOINTS } from '../../types.ts';
import { fileLine, fullTime, inboxFor, replyHref, shortTime } from './store.ts';

export function InboxStage({ back, onBack }: { back: string; onBack: () => void }) {
	const editor = useEditor();
	const inbox = inboxFor(editor);
	const openId = useStore(editor.view, (v) => v.inbox?.id ?? null);
	const open = useStore(inbox.open);
	const off = useStore(editor.submissions, (s) => s.unread === null);
	const empty = useStore(inbox.list, (l) => l.rows !== null && l.rows.length === 0);
	if (openId && open?.id === openId && open.answer) return <Sheet answer={open.answer} sending={open.sending === true} />;
	if (openId && open?.id === openId && open.error) {
		return (
			<div className="in">
				<Icon name="inbox" />
				<h2>This message can’t be shown</h2>
				<p>{open.error}</p>
				<button type="button" className="btn" onClick={() => editor.openInbox(null)}>
					<Icon name="chev-l" size="sm" />
					Back to the list
				</button>
			</div>
		);
	}
	// Opening one: the last state stays until it's there (no skeleton), so nothing flickers.
	const h = off ? 'Nothing to show yet' : empty ? 'Nothing to read yet' : 'Choose a message to read it';
	return (
		<div className="in">
			<Icon name="inbox" />
			<h2>{h}</h2>
			<button type="button" className="btn" data-act="back-to-page" onClick={onBack}>
				<Icon name="chev-l" size="sm" />
				Back to {back}
			</button>
		</div>
	);
}

/** The form's fields as the sheet lists them: the config's, in order; a form no longer in the config, the stored names. */
function fieldRows(answer: SubmissionResponse) {
	const { submission, form } = answer;
	const values = submission.fields ?? {};
	if (form) return form.fields.map((f) => ({ ...f }));
	const rows: (Pick<ResolvedFormField, 'name' | 'label' | 'options' | 'source' | 'columns'> & { type: string })[] = Object.keys(values).map((name) => ({ name, label: name, type: 'text' }));
	if (submission.files?.length) rows.push({ name: 'files', label: 'Files', type: 'files' });
	return rows;
}

function Sheet({ answer, sending }: { answer: SubmissionResponse; sending: boolean }) {
	const editor = useEditor();
	const inbox = inboxFor(editor);
	const brand = useStore(editor.brand, (b) => b.name);
	const { submission, form } = answer;
	const timeZone = editor.timeZone();
	const values = submission.fields ?? {};
	const who = senderName(form, values) || 'Someone';
	const address = typeof values.email === 'string' ? values.email : '';
	const formLabel = form?.label ?? submission.form;
	const subject = `Re: your enquiry to ${brand}`;
	const body = useRef<HTMLDivElement>(null);
	// Braces: Chromium's scrollTo returns a promise now, and an effect may only return a cleanup.
	useEffect(() => {
		body.current?.scrollTo(0, 0);
	}, [submission.id]);

	const markUnread = async () => {
		const answer = await inbox.markUnread(submission.id);
		if (!answer.ok) {
			editor.toast(answer.error ?? "It couldn't be marked unread.", 'warn');
			return;
		}
		// Only if it's still the one open (another may have been opened meanwhile).
		if (editor.view.get().inbox?.id === submission.id) editor.openInbox(null);
		editor.toast('Marked unread', 'unread');
		requestAnimationFrame(() => document.querySelector<HTMLElement>(`#side .srow[data-id="${CSS.escape(submission.id)}"]`)?.focus());
	};
	const close = () => {
		editor.openInbox(null);
		requestAnimationFrame(() => document.querySelector<HTMLElement>(`#side .srow[data-id="${CSS.escape(submission.id)}"]`)?.focus());
	};

	return (
		<article className="sub-sheet" aria-labelledby="sub-h" data-submission={submission.id}>
			<header className="sub-head">
				<div className="sub-meta">
					<span className="chip">
						<Icon name="b-form" size="xs" />
						{formLabel} form
					</span>
					<span>{fullTime(submission.receivedAt, timeZone, editor.timeZoneName())}</span>
					<button type="button" className="ib end" style={{ marginLeft: 'auto' }} data-act="sub-close" aria-label="Close" onClick={close}>
						<Icon name="x" size="sm" />
					</button>
				</div>
				<h2 id="sub-h" tabIndex={-1}>
					{who}
				</h2>
				<p className="from">{address}</p>
				<div className="sub-acts">
					{address ? (
						<a className="btn ink" href={replyHref(address, brand)} data-act="reply" title={`Opens your email, with the subject “${subject}”`}>
							<Icon name="reply" size="sm" />
							Reply by email
						</a>
					) : null}
					<button type="button" className="btn" data-act="sub-unread" onClick={() => void markUnread()}>
						<Icon name="unread" size="sm" />
						Mark unread
					</button>
					<button
						type="button"
						className="btn quiet-danger end"
						data-act="sub-delete"
						onClick={() => openDialog(editor, { kind: 'sub-delete', id: submission.id, who, files: submission.files?.length ?? 0 })}
					>
						<Icon name="trash" size="sm" />
						Delete…
					</button>
				</div>
			</header>
			<div className="sub-body" ref={body}>
				{submission.spam ? (
					<PossiblySpam id={submission.id} />
				) : sending ? (
					<div className="note" data-mail="sending" role="status">
						<Icon name="mail" />
						<div>
							<b>Sending the email</b>
							<p>It goes to whoever gets {formLabel} emails, as any other enquiry’s does.</p>
						</div>
					</div>
				) : (
					<MailOutcome email={submission.email} formLabel={formLabel} timeZone={timeZone} editor={editor} />
				)}
				<dl className="sub-fields">
					{fieldRows(answer).map((f) => {
						if (f.type === 'files') {
							const files = submission.files ?? [];
							return [
								<dt key={`${f.name}:t`}>{f.label}</dt>,
								files.length ? (
									<dd key={`${f.name}:d`}>
										<div className="sub-files">
											{files.map((file, i) => (
												<FileRow key={file.key} submission={submission} n={i + 1} name={shownFileName(file.name) || shownFileName(file.key)} size={file.size} keyName={file.key} />
											))}
										</div>
									</dd>
								) : submission.filesNote ? (
									// The cloud's attachment limit: the files weren't kept. Said plainly, not as an error; the sentence is the cloud's.
									<dd key={`${f.name}:d`}>
										<div className="note" data-files="not-kept">
											<Icon name="attach" />
											<div>
												<p>{submission.filesNote}</p>
											</div>
										</div>
									</dd>
								) : (
									<dd key={`${f.name}:d`} className="none">
										No files
									</dd>
								),
							];
						}
						// Form rows Decision 11: a rows value as lines, one per row (titles for sourced cells); a list the form doesn't
						// declare as rows (another type, or the form gone) as `column: value` lines, never "[object Object]".
						const stored = values[f.name];
						const titles = answer.titles ?? {};
						const raw = typeof stored === 'string' ? stored : '';
						const shown = Array.isArray(stored)
							? (f.type === 'rows' ? rowsLines(f, stored, titles) : plainRowLines(stored)).join('\n')
							: f.type === 'select' && raw
								? shownChoice(f, raw, titles)
								: raw;
						return [
							<dt key={`${f.name}:t`}>{f.label}</dt>,
							shown ? (
								<dd key={`${f.name}:d`} data-value={f.name}>
									{shown}
								</dd>
							) : (
								<dd key={`${f.name}:d`} className="none">
									Not given
								</dd>
							),
						];
					})}
				</dl>
			</div>
		</article>
	);
}

function FileRow({ submission, n, name, size, keyName }: { submission: StoredSubmission; n: number; name: string; size: number; keyName: string }) {
	// The stored key's extension (what the download's type comes from), as the mockup shows it.
	const ext = (/\.([a-z0-9]+)$/i.exec(keyName)?.[1] ?? '').toUpperCase().replace('JPEG', 'JPG');
	return (
		<a className="frow" href={`${ENDPOINTS.submissions}/${encodeURIComponent(submission.id)}/files/${n}`} download={name} title={`Download ${name}`} data-file={n}>
			<span className="ext">{ext}</span>
			<span className="t">
				<b>{name}</b>
				<small>{fileLine(size, ext)}</small>
			</span>
			<Icon name="download" />
		</a>
	);
}

/**
 * The cloud's spam check marked it as possibly spam, so its email was held (email feedback,
 * 2026-11-11). Calm, as a held email is: the plain note, and the one way out. The sheet and the
 * row update from the answer; an error is a toast, as Mark unread's is.
 */
function PossiblySpam({ id }: { id: string }) {
	const editor = useEditor();
	const inbox = inboxFor(editor);
	const [busy, setBusy] = useState(false);
	const release = async () => {
		setBusy(true);
		const answer = await inbox.notSpam(id);
		setBusy(false);
		if (!answer.ok) {
			editor.toast(answer.error ?? "The email couldn't be sent just now.", 'warn');
			return;
		}
		editor.toast(answer.submission?.email?.status === 'held' ? 'Not spam: its email is held' : 'Not spam: sending its email', 'mail');
	};
	return (
		<div className="note" data-mail="spam">
			<Icon name="mail" />
			<div>
				<b>Possibly spam</b>
				<p>CaraCMS marked this enquiry as possibly spam, so the email about it wasn’t sent.</p>
				<div className="acts">
					<button type="button" className="btn sm" data-act="sub-not-spam" disabled={busy} aria-busy={busy || undefined} onClick={() => void release()}>
						Not spam, send it
					</button>
				</div>
			</div>
		</div>
	);
}

function MailOutcome({ email, formLabel, timeZone, editor }: { email: EmailOutcome | undefined; formLabel: string; timeZone: string; editor: Editor }) {
	if (!email) {
		return (
			<div className="note warn" data-mail="unknown">
				<Icon name="warn" />
				<div>
					<b>It isn’t known whether the email went out</b>
					<p>Check with whoever gets {formLabel} emails.</p>
				</div>
			</div>
		);
	}
	if (email.status === 'sent') {
		return (
			<p className="sub-mail sent" data-mail="sent">
				<Icon name="check" />
				<span>
					Emailed to{' '}
					{email.to.map((a, i) => (
						<Fragment key={a}>
							{i === 0 ? '' : i === email.to.length - 1 ? ' and ' : ', '}
							<span className="mono">{a}</span>
						</Fragment>
					))}{' '}
					at {shortTime(email.at, timeZone)}.
				</span>
			</p>
		);
	}
	if (email.status === 'failed') {
		return (
			<div className="note danger" data-mail="failed">
				<Icon name="warn" />
				<div>
					<b>The email about it didn’t go out</b>
					<p>Resend said:</p>
					<q>{email.error ?? 'No reason was given.'}</q>
					<p style={{ marginTop: 'var(--space-1-5)' }}>Your developer can fix that.</p>
				</div>
			</div>
		);
	}
	if (email.status === 'held') {
		// Finding 20 (caracms-cloud adversarial review): the cloud holds it behind the site's daily
		// limit; it goes out on its own, so it's calm, not a problem. The sentence is the cloud's.
		return (
			<div className="note" data-mail="held">
				<Icon name="clock" />
				<div>
					<b>Email held</b>
					<p>{email.error ?? 'The email about it is waiting to go out.'}</p>
				</div>
			</div>
		);
	}
	// Skipped: no one to email (Site Settings sets who), or not the production server (which alone sends email).
	const notProduction = (email.error ?? '').startsWith('Not emailed');
	return (
		<div className="note" data-mail="skipped">
			<Icon name="mail" />
			<div>
				<b>No email was sent</b>
				{notProduction ? (
					<p>{email.error}</p>
				) : (
					<>
						<p>The {formLabel} form had no one to email.</p>
						<div className="acts">
							<button
								type="button"
								className="btn sm"
								data-act="open-settings"
								onClick={() => void editor.openDocument({ collection: 'settings', path: editor.documents.get().find((d) => d.collection === 'settings')?.path ?? 'site-settings' })}
							>
								Open Site Settings
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
