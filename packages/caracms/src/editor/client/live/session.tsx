/**
 * The session in live mode (M4 Decisions 11 and 14; the mockup's #account,
 * #signed-out-edit and #offline):
 *
 * - `AccountButton` / `AccountPop`: the signed-in avatar in the bar, opening who is
 *   signed in and **Sign out** (`POST /admin/login/signout`, then its `location`).
 * - `SignedOutModal`: "You've been signed out". The edits stay in the tab; **Sign in
 *   again** opens sign-in in a new tab, and this tab sends them once its next poll
 *   answers (editor.ts → recheck). A person removed from the whitelist gets the
 *   plain sentence that their latest changes couldn't be kept, and no way back.
 * - `OfflineExtras`: the offline note's live-mode lines: the unsent count, "Trying
 *   again in 12 s." (the retry timer runs only while offline) and **Try now**.
 */
import { useEffect, useRef, useState } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { Icon } from '../shell/Icons.tsx';
import { displayName } from './format.ts';
import { Avatar } from './marks.tsx';

export function AccountButton() {
	const editor = useEditor();
	const pop = useStore(editor.view, (v) => v.pop);
	const you = useStore(editor.liveState, (s) => s.status?.you ?? editor.you);
	if (!you) return <span data-slot="account" hidden />;
	return (
		<button
			type="button"
			className="me"
			data-slot="account"
			aria-haspopup="dialog"
			aria-expanded={pop === 'account'}
			aria-label={`Signed in as ${displayName(you)}`}
			onClick={() => editor.setPop(pop === 'account' ? null : 'account')}
		>
			<Avatar person={you} />
		</button>
	);
}

export function AccountPop() {
	const editor = useEditor();
	const you = useStore(editor.liveState, (s) => s.status?.you ?? editor.you);
	const ref = useRef<HTMLDivElement>(null);
	const [leaving, setLeaving] = useState(false);
	useEffect(() => {
		const onDown = (event: MouseEvent) => {
			const target = event.target as Element | null;
			if (!target || ref.current?.contains(target) || target.closest?.('.me')) return;
			editor.setPop(null);
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [editor]);
	if (!you) return null;
	return (
		<div ref={ref} className="pop" role="dialog" aria-label="Account" data-pop="account" style={{ right: 8, width: 280 }}>
			<div className="acct">
				<div className="who">
					<Avatar person={you} size="lg" />
					<div>
						<b>{displayName(you)}</b>
						<small>{you.email}</small>
					</div>
				</div>
				<hr />
				<button
					type="button"
					className="btn block"
					data-act="sign-out"
					disabled={leaving}
					onClick={() => {
						setLeaving(true);
						void editor.signOut();
					}}
				>
					<Icon name="signout" size="sm" />
					Sign out
				</button>
			</div>
		</div>
	);
}

export function SignedOutModal() {
	const editor = useEditor();
	const signedOut = useStore(editor.liveState, (s) => s.signedOut);
	const unsent = useStore(editor.keep, (k) => k.unsent ?? 0);
	const title = useStore(editor.doc.state, (s) => s.document.title || s.entry.label);
	const button = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (signedOut) button.current?.focus();
	}, [signedOut]);
	if (!signedOut) return null;
	if (signedOut.reason === 'removed') {
		return (
			<div className="scrim" data-modal="removed">
				<div className="dialog danger" role="alertdialog" aria-modal="true" aria-labelledby="dlg-h" aria-describedby="dlg-d">
					<div className="icon-h" style={{ background: 'var(--status-danger-wash)', color: 'var(--status-danger)' }}>
						<Icon name="signout" />
					</div>
					<h2 id="dlg-h">You can't sign in to {editor.brand.get().name} any more</h2>
					<p id="dlg-d">You can no longer sign in, so your latest changes couldn't be kept.</p>
				</div>
			</div>
		);
	}
	return (
		<div className="scrim" data-modal="signed-out">
			<div className="dialog danger" role="alertdialog" aria-modal="true" aria-labelledby="dlg-h">
				<div className="icon-h" style={{ background: 'var(--status-danger-wash)', color: 'var(--status-danger)' }}>
					<Icon name="signout" />
				</div>
				<h2 id="dlg-h">You've been signed out</h2>
				{unsent > 0 ? (
					<>
						<p>
							{unsent} change{unsent === 1 ? '' : 's'} to {title} {unsent === 1 ? "hasn't" : "haven't"} reached the server.
						</p>
						<p>Keep this tab open and sign in again.</p>
					</>
				) : (
					<p>Sign in again to keep editing.</p>
				)}
				<div className="acts">
					<button ref={button} type="button" className="btn ink" data-act="signin-again" onClick={() => editor.signInAgain()}>
						<Icon name="ext" size="sm" />
						Sign in again
					</button>
				</div>
				<p className="field-help" style={{ marginTop: 'var(--space-3)', textAlign: 'right' }}>
					Opens in a new tab.
				</p>
			</div>
		</div>
	);
}

/** The offline note's countdown, Try now and the unsent count (live mode; M3 left their slots). */
export function OfflineExtras() {
	const editor = useEditor();
	const retryAt = useStore(editor.keep, (k) => k.retryAt ?? null);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (retryAt === null) return;
		setNow(Date.now());
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [retryAt]);
	const seconds = retryAt === null ? null : Math.max(0, Math.ceil((retryAt - now) / 1000));
	return (
		<>
			<p style={{ marginTop: 6 }} data-slot="retry-countdown">
				{seconds === null || seconds === 0 ? 'Trying again…' : `Trying again in ${seconds} s.`}
			</p>
			<div className="acts" data-slot="try-now">
				<button type="button" className="btn sm" data-act="try-now" onClick={() => editor.keeper?.tryNow()}>
					Try now
				</button>
			</div>
		</>
	);
}
