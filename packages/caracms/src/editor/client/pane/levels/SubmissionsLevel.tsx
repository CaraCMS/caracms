/**
 * The inbox level, Site-wide → Submissions (M6 Decision 9; the mockup's #submissions,
 * #submissions-older, #submissions-empty, #submissions-off): `view.level === 'submissions'`.
 *
 * - **The list**, newest first, 50 at a time with Older (by cursor). A row: the unread
 *   mark (a dot and a heavier name, never a side rail), who sent it, when (the site's
 *   zone: "14:12" today, then "Yesterday" or "Tue 13 Oct"), a one-line snippet, the
 *   form, the file count, **Email held** (quiet, beside the file count: a cloud site's
 *   daily limit; finding 20) and **Email failed** when its email failed. The open one has
 *   the selection's wash and ring.
 * - **A row opens the submission** on a sheet over the dimmed page (inbox/InboxStage.tsx),
 *   with the list kept here; the address follows (`/admin/submissions/<id>`).
 * - **Not set up** (the production server has no bucket): the amber note naming the
 *   variables, since a live form then fails for visitors.
 * - Last-known rows while the list is read again (on opening, and on intent from the
 *   Site-wide row); the first paint of `/admin/submissions` has them (admin-props.ts).
 *
 * Everything a visitor typed is React text: never HTML.
 */
import { Fragment, useEffect } from 'react';
import { useEditor, useStore } from '../../context.tsx';
import { inboxFor, filesLabel, rowTime } from '../../inbox/store.ts';
import { Icon } from '../../shell/Icons.tsx';
import type { SubmissionRow } from '../../../types.ts';
import { CurrentHead, DocumentsTab, GlobalNotes, RecentStrip, Trail } from '../parts.tsx';

/** Where the inbox's not-set-up note and the documents level read whether it's off. */
export function useSubmissionsOff() {
	const editor = useEditor();
	return useStore(editor.submissions, (s) => (s.unread === null ? s : null));
}

export function SubmissionsLevel() {
	const editor = useEditor();
	const inbox = inboxFor(editor);
	const rows = useStore(inbox.list, (l) => l.rows);
	const older = useStore(inbox.list, (l) => l.older);
	const olderLoading = useStore(inbox.list, (l) => l.olderLoading);
	const error = useStore(inbox.list, (l) => l.error);
	const unread = useStore(editor.submissions, (s) => s.unread ?? 0);
	const off = useSubmissionsOff();
	const openId = useStore(editor.view, (v) => v.inbox?.id ?? null);
	const timeZone = editor.timeZone();

	// The list read again on opening (last known stays on screen meanwhile); the open one read, and marked read.
	useEffect(() => {
		void inbox.load();
	}, [inbox]);
	useEffect(() => {
		if (openId) void inbox.show(openId);
	}, [inbox, openId]);

	let body;
	if (off) body = <SubmissionsOffNote off={off} />;
	else if (rows && rows.length === 0)
		body = (
			<div className="empty">
				<b>No messages yet</b>
				<button type="button" className="linkbtn" style={{ marginTop: 'var(--space-1)' }} data-act="open-settings" onClick={() => void editor.openDocument({ collection: 'settings', path: settingsPath(editor) })}>
					Who gets the email
				</button>
			</div>
		);
	else if (rows)
		body = (
			<>
				<div className="srows">
					{rows.map((row) => (
						<Row key={row.id} row={row} current={row.id === openId} timeZone={timeZone} onOpen={() => editor.openInbox(row.id)} />
					))}
				</div>
				{older || rows.length > 50 ? (
					<div className="subs-foot">
						{older ? (
							<button type="button" className="btn sm block" data-act="subs-older" disabled={olderLoading} onClick={() => void inbox.loadOlder()}>
								Older
							</button>
						) : (
							<p className="kb-hint">No older messages.</p>
						)}
					</div>
				) : null}
			</>
		);
	return (
		<>
			<Trail>
				<DocumentsTab />
				<CurrentHead
					back={{ label: 'Back to documents', onClick: () => editor.goTo('documents') }}
					title="Submissions"
					chips={unread && !off ? <span className="n-chip">{unread} unread</span> : null}
				/>
			</Trail>
			<div className="side-body" data-inbox="">
				<GlobalNotes />
				{error && !off ? (
					<div className="note warn tight" role="status" data-note="inbox-error">
						<Icon name="warn" />
						<div>
							<p>{error}</p>
						</div>
					</div>
				) : null}
				{body}
			</div>
			<RecentStrip />
		</>
	);
}

const settingsPath = (editor: ReturnType<typeof useEditor>) => editor.documents.get().find((d) => d.collection === 'settings')?.path ?? 'site-settings';

function Row({ row, current, timeZone, onOpen }: { row: SubmissionRow; current: boolean; timeZone: string; onOpen: () => void }) {
	const unread = row.readAt === null;
	const failed = row.emailStatus === 'failed';
	// The cloud's spam check (email feedback, 2026-11-11): said as quietly as a held email, and in its place (its email is held for it).
	const spam = row.spam === true;
	// Finding 20: a held email is said quietly, beside the files, never as a failure.
	const held = row.emailStatus === 'held' && !spam;
	// The cloud's attachment limit: said as quietly as a held email.
	const notKept = row.filesNotKept === true;
	const time = rowTime(row.receivedAt, timeZone);
	const label = [row.name, `${row.formLabel} form`, time, unread ? 'unread' : '', row.files ? filesLabel(row.files) : '', failed ? 'email failed' : '', held ? 'email held' : '', spam ? 'possibly spam' : '', notKept ? 'attachments not kept' : ''].filter(Boolean).join(', ');
	return (
		<button
			type="button"
			className={`srow${unread ? ' is-unread' : ''}${current ? ' is-current' : ''}`}
			data-id={row.id}
			aria-current={current ? 'true' : undefined}
			aria-label={label}
			onClick={onOpen}
		>
			<span className="ud" aria-hidden="true" />
			<span>
				<span className="l1">
					<span className="who">{row.name}</span>
					<span className="tm">{time}</span>
				</span>
				<span className="sn">{row.snippet ? row.snippet : <span style={{ color: 'var(--text-subtle)' }}>No message</span>}</span>
				<span className="l3">
					<span>{row.formLabel}</span>
					{row.files ? (
						<span>
							<Icon name="attach" />
							{filesLabel(row.files)}
						</span>
					) : null}
					{notKept ? (
						<span data-files="not-kept">
							<Icon name="attach" />
							Attachments not kept
						</span>
					) : null}
					{spam ? (
						<span data-mail="spam">
							<Icon name="mail" />
							Possibly spam
						</span>
					) : null}
					{held ? (
						<span data-mail="held">
							<Icon name="clock" />
							Email held
						</span>
					) : null}
					{failed ? (
						<span className="chip danger">
							<Icon name="warn" size="xs" />
							Email failed
						</span>
					) : null}
				</span>
			</span>
		</button>
	);
}

/** `submissions-off`: the amber note naming what's missing, or why the count couldn't be read. */
export function SubmissionsOffNote({ off }: { off: { error: string; code: string; missing: string[] } }) {
	return (
		<div className="note warn tight" role="status" data-note="submissions-off">
			<Icon name="inbox" />
			<div>
				{off.code === 'submissions-unset' ? (
					<>
						<b>Submissions aren’t set up on this server yet</b>
						<p>
							It needs{' '}
							{off.missing.length
								? off.missing.map((v, i) => (
										<Fragment key={v}>
											{i === 0 ? '' : i === off.missing.length - 1 ? ' and ' : ', '}
											<span className="mono">{v}</span>
										</Fragment>
									))
								: 'its bucket’s variables'}
							. Until then, forms can’t take messages.
						</p>
					</>
				) : (
					<>
						<b>Submissions can’t be read just now</b>
						<p>{off.error}</p>
					</>
				)}
			</div>
		</div>
	);
}
