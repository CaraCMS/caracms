/**
 * The open document's notes in live mode (the mockup's docNotes; M4 Decisions 7, 9,
 * 10 and 11), under the pane's global notes in the document and block levels:
 *
 * - **Someone else's lock** (`#locked`): "Aoife is editing", read-only until they're
 *   done, opening up without a reload, with **Take over** (asks once, inline).
 * - **Your own lock in another tab**: "You're editing this in another tab", with
 *   **Edit here** (the lock note, M4's added state in the mockup's language).
 * - **Edits that weren't kept** (Decision 11): "You had changes here that weren't
 *   kept before Aoife edited it", with **Use mine** (off while someone else holds the
 *   lock) and **Discard mine**.
 * - **The merge notice** (`#merge`), until dismissed or published.
 * - **"Aoife published Home as it stood at 14:20"** (`#published-over`).
 * - **"Aoife discarded the unpublished changes to About"** (Discard changes), with OK.
 * - **Someone deleted it** (M5a Decision 12: the poll's `open.deleted`): who and when,
 *   read-only, with a way back to the documents.
 *
 * `ReadOnlyChip` is the head's "Read-only" chip under a lock. Local mode: nothing.
 */
import { useState } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { Icon } from '../shell/Icons.tsx';
import type { NoticeView, Person } from '../../types.ts';
import { clock, displayName, when } from './format.ts';
import { Avatar } from './marks.tsx';

export function ReadOnlyChip() {
	const editor = useEditor();
	const veil = useStore(editor.access, (a) => a.veil);
	if (!veil) return null;
	return (
		<span className="chip lock" data-chip="read-only">
			<Icon name="lock" size="xs" />
			Read-only
		</span>
	);
}

export function DocNotices() {
	const editor = useEditor();
	const access = useStore(editor.access);
	const file = useStore(editor.doc.state, (s) => s.entry.file);
	const title = useStore(editor.doc.state, (s) => s.document.title || s.entry.label);
	const notices = useStore(editor.liveState, (s) => s.status?.notices);
	const timeZone = useStore(editor.liveState, (s) => s.status?.timeZone ?? 'UTC');
	if (editor.mode !== 'live') return null;
	const mine = (notices ?? []).filter((n) => n.file === file);
	const holder = access.holder;
	const theirs = access.lock === 'theirs' && holder;
	if (access.deleted) return <DeletedNote title={title} deleted={access.deleted} timeZone={timeZone} />;
	return (
		<>
			{theirs ? <LockNote key={`${file}:${holder.person.email}`} title={title} /> : null}
			{access.lock === 'yours-elsewhere' ? (
				<div className="note lock" role="status" data-note="elsewhere">
					{editor.you ? <Avatar person={editor.you} /> : <Icon name="lock" />}
					<div>
						<b>You're editing this in another tab</b>
						<p>{title} is read-only here.</p>
						<div className="acts">
							<button type="button" className="btn sm" data-act="edit-here" onClick={() => void editor.editHere()}>
								Edit here
							</button>
						</div>
					</div>
				</div>
			) : null}
			{access.held ? <HeldNote /> : null}
			{mine.map((n) => (
				<Notice key={n.id} notice={n} timeZone={timeZone} />
			))}
		</>
	);
}

/** Someone else's lock, with Take over (asked once, inline, before it moves the lock). */
function LockNote({ title }: { title: string }) {
	const editor = useEditor();
	const holder = useStore(editor.access, (a) => a.holder)!;
	const status = useStore(editor.liveState, (s) => s.status);
	const [asking, setAsking] = useState(false);
	const [busy, setBusy] = useState(false);
	const name = displayName(holder.person);
	const change = status?.open?.lastChange;
	const theirChange = change?.at && change.by && change.by.email.toLowerCase() === holder.person.email.toLowerCase() ? change.at : null;
	const takeOver = async () => {
		setBusy(true);
		try {
			await editor.takeOver();
		} finally {
			setBusy(false);
			setAsking(false);
		}
	};
	return (
		<div className="note lock" role="status" data-note="locked">
			<Avatar person={holder.person} />
			<div>
				<b>{name} is editing</b>
				{asking ? (
					<>
						<p>Take over {title} from {name}? Their changes are kept.</p>
						<div className="acts">
							<button type="button" className="btn sm" data-act="take-over-confirm" disabled={busy} onClick={() => void takeOver()}>
								Take over
							</button>
							<button type="button" className="btn sm ghost" data-act="take-over-cancel" disabled={busy} onClick={() => setAsking(false)}>
								Cancel
							</button>
						</div>
					</>
				) : (
					<>
						<p>
							{title} is read-only while {name} has it open.
							{theirChange && status ? ` Their last change: ${when(theirChange, status.timeZone, status.now)}.` : ''}
						</p>
						<div className="acts">
							<button type="button" className="btn sm" data-act="take-over" onClick={() => setAsking(true)}>
								Take over
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function HeldNote() {
	const editor = useEditor();
	const access = useStore(editor.access);
	const held = access.held!;
	const theirs = access.lock === 'theirs' ? access.holder : null;
	const who = held.elsewhere ? null : held.by;
	// No name, and not your other tab: the server couldn't tell who changed it (Decision 11, `known: false`).
	const whom = who ? `before ${displayName(who)} edited it` : held.elsewhere || held.reason === 'locked' ? 'before you edited it in another tab' : 'before it was changed elsewhere';
	return (
		<div className="note warn" role="alert" data-note="not-kept">
			<Icon name="warn" />
			<div>
				<b>You had changes here that weren't kept {whom}</b>
				<p>Held in this browser.</p>
				<div className="acts">
					<button type="button" className="btn sm" data-act="use-mine" disabled={!!theirs} onClick={() => void editor.useMine()}>
						Use mine
					</button>
					<button type="button" className="btn sm" data-act="discard-mine" onClick={() => void editor.discardMine()}>
						Discard mine
					</button>
					{theirs ? <p className="why">Use mine is off while {displayName(theirs.person)} is editing.</p> : null}
				</div>
			</div>
		</div>
	);
}

function Notice({ notice, timeZone }: { notice: NoticeView; timeZone: string }) {
	const editor = useEditor();
	if (notice.kind === 'draft-kept') {
		return (
			<div className="note warn" role="status" data-note="draft-kept">
				<Icon name="warn" />
				<div>
					<b>{notice.title} was also changed outside the editor.</b>
					<p>Your draft was kept; check it before publishing.</p>
					<div className="acts">
						<button type="button" className="btn sm" data-act="dismiss" onClick={() => editor.dismissNotice(notice.id)}>
							Dismiss
						</button>
					</div>
				</div>
			</div>
		);
	}
	if (notice.kind === 'discarded') {
		return (
			<div className="note select" role="status" data-note="discarded">
				<Icon name="undo" />
				<div>
					<b>
						{displayName(notice.by)} discarded the unpublished changes to {notice.title} at {clock(notice.at, timeZone)}
					</b>
					<p>It's back to what's live.</p>
					<div className="acts">
						<button type="button" className="btn sm" data-act="dismiss" onClick={() => editor.dismissNotice(notice.id)}>
							OK
						</button>
					</div>
				</div>
			</div>
		);
	}
	return (
		<div className="note select" role="status" data-note="published-over">
			<Icon name="check" />
			<div>
				<b>
					{displayName(notice.by)} published {notice.title} as it stood at {clock(notice.at, timeZone)}
				</b>
				<div className="acts">
					<button type="button" className="btn sm" data-act="dismiss" onClick={() => editor.dismissNotice(notice.id)}>
						OK
					</button>
				</div>
			</div>
		</div>
	);
}

/** The open document was deleted by someone else (M5a Decision 12): read-only, saying who and when. */
function DeletedNote({ title, deleted, timeZone }: { title: string; deleted: { by: Person | null; at: string | null }; timeZone: string }) {
	const editor = useEditor();
	const by = deleted.by ? displayName(deleted.by) : null;
	const at = deleted.at ? clock(deleted.at, timeZone) : null;
	return (
		<div className="note danger" role="alert" data-note="deleted">
			<Icon name="trash" />
			<div>
				<b>{by ? `${by} deleted ${title}` : `${title} was deleted`}</b>
				<p>
					{at ? `It was deleted at ${at}. ` : ''}It can't be edited.
				</p>
				<div className="acts">
					<button type="button" className="btn sm" data-act="deleted-back" onClick={() => editor.goTo('documents')}>
						Back to documents
					</button>
				</div>
			</div>
		</div>
	);
}
