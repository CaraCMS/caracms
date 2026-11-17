/**
 * Pieces every pane level is built from (the mockup's sidebar components): the
 * trail with the stacked level tabs, the current level's header, the notes every
 * level shows (the GitHub access note among them, runs-anywhere Decision 5), and the
 * Recent strip at the foot. A level is
 *
 *   <>
 *     <Trail>{level tabs}<CurrentHead … /></Trail>
 *     <div className="side-body"><GlobalNotes />…</div>
 *     <RecentStrip />
 *   </>
 */
import type { ReactNode } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { Icon } from '../shell/Icons.tsx';
import { docId, opensInEditor } from '../../types.ts';
import { useTooLong } from '../nav/DocRow.tsx';
import { DocMarksView } from '../live/marks.tsx';
import { OfflineExtras } from '../live/session.tsx';

export function Trail({ children }: { children: ReactNode }) {
	return <div className="trail">{children}</div>;
}

/** A stacked level tab: the level you came from (`.lv`). */
export function LevelTab({ name, kind, count, onClick }: { name: string; kind?: string; count?: string; onClick: () => void }) {
	return (
		<button type="button" className="lv" onClick={onClick}>
			<b>{name}</b>
			{kind ? <span>· {kind}</span> : null}
			{count !== undefined ? <span className="n">{count}</span> : null}
		</button>
	);
}

/** The documents level's tab, for the levels below it: the site's name is enough. */
export function DocumentsTab() {
	const editor = useEditor();
	const name = useStore(editor.brand, (b) => b.name);
	return <LevelTab name={name} onClick={() => editor.goTo('documents')} />;
}

/**
 * Edit in context (Decision 8): the page a document is open over, for the sidebar's head: its
 * name (the listing's), and how many blocks it had. Null while the open document isn't over one.
 */
export function useOverPage(): { name: string; blocks: number | null } | null {
	const editor = useEditor();
	const over = useStore(editor.over);
	const name = useStore(editor.documents, (d) => (over ? (d.find((x) => x.collection === over.page.collection && x.path === over.page.path)?.label ?? null) : null));
	return over ? { name: name ?? 'Home', blocks: over.blocks } : null;
}

/** The page's tab above a document open over it (the mockup's "Home · Blocks"): it goes back to the page. */
export function OverPageTab() {
	const editor = useEditor();
	const page = useOverPage();
	if (!page) return null;
	const count = page.blocks === null ? undefined : `${page.blocks} block${page.blocks === 1 ? '' : 's'}`;
	return <LevelTab name={page.name} kind="Blocks" count={count} onClick={() => void editor.backToPage()} />;
}

/** "Back to Home", for the head of a document open over a page (Esc at the form's top does the same). */
export function useOverBack(): { label: string; onClick: () => void } | null {
	const editor = useEditor();
	const page = useOverPage();
	return page ? { label: `Back to ${page.name}`, onClick: () => void editor.backToPage() } : null;
}

/** The current level's header (`.cur`): back, a crumb, the title, chips, a sub line, a menu and extras. */
export function CurrentHead(props: {
	back?: { label: string; onClick: () => void };
	crumb?: string;
	title: ReactNode;
	chips?: ReactNode;
	sub?: ReactNode;
	menu?: ReactNode;
	extra?: ReactNode;
	lead?: ReactNode;
}) {
	return (
		<div className="cur">
			<div className="cur-row">
				{props.back ? (
					<button type="button" className="ib boxed" aria-label={props.back.label} onClick={props.back.onClick}>
						<Icon name="chev-l" />
					</button>
				) : null}
				{props.lead}
				<div className="cur-title">
					<span className="t">
						{props.crumb ? <span className="crumbp">{props.crumb} /</span> : null}
						<span>{props.title}</span>
						{props.chips}
					</span>
					{props.sub ? <span className="sub">{props.sub}</span> : null}
				</div>
				{props.menu}
			</div>
			{props.extra}
		</div>
	);
}

/**
 * Notes every level shows above its content: GitHub access (live mode, below), then
 * "Can't reach the server" (Decision 6),
 * or, when the server answered a write with a refusal (a 4xx: the edits don't fit
 * their base, the file was renamed or deleted while open), its own message. M3
 * retries with the next change or a reload (no timer), so M4's countdown, "Try now"
 * and unsent count are slots without data.
 */
export function GlobalNotes() {
	return (
		<>
			<GitHubAccessNote />
			<DraftsLostNote />
			<RolledBackNote />
			<CommitTroubleNote />
			<KeepNotes />
		</>
	);
}

/**
 * Runs-anywhere Decision 5: the site's GitHub access is wrong (a refused credential, a
 * missing permission, a token expiring soon), for everyone, on every level, while it
 * holds. Not dismissable. The sentence is the server's (`status.githubAccess`).
 */
function GitHubAccessNote() {
	const editor = useEditor();
	const access = useStore(editor.liveState, (s) => s.status?.githubAccess ?? null);
	if (editor.mode !== 'live' || !access) return null;
	// caracms-cloud adversarial review, finding 7: a rename taken in its stride is information, in the plain note.
	const renamed = access.kind === 'renamed';
	const expiring = access.kind === 'expiring';
	return (
		<div
			className={renamed ? 'note' : `note ${expiring ? 'warn' : 'danger'}`}
			role={renamed || expiring ? 'status' : 'alert'}
			data-note="github-access"
			data-kind={access.kind}
		>
			<Icon name={renamed ? 'check' : 'warn'} />
			<div>
				<b>{access.title}</b>
				<p>{withLink(access.message, access.link ?? null)}</p>
			</div>
		</div>
	);
}

/**
 * caracms-cloud adversarial review, finding 4: edits are kept on the server but its commits
 * to GitHub keep failing (the bar says so too). Left out while the access note shows a
 * problem: that one already says what's wrong and who fixes it (finding 7's rename says neither).
 */
function CommitTroubleNote() {
	const editor = useEditor();
	const trouble = useStore(editor.liveState, (s) => s.status?.commitTrouble ?? null);
	const access = useStore(editor.liveState, (s) => s.status?.githubAccess ?? null);
	if (editor.mode !== 'live' || !trouble || (access && access.kind !== 'renamed')) return null;
	return (
		<div className="note danger" role="alert" data-note="commit-trouble">
			<Icon name="warn" />
			<div>
				<b>Changes aren't reaching GitHub</b>
				<p>{trouble.message}</p>
			</div>
		</div>
	);
}

/** Finding 5: the `drafts` branch went missing and was made again from `main`; the sentence is the server's. */
function DraftsLostNote() {
	const editor = useEditor();
	const lost = useStore(editor.liveState, (s) => s.status?.draftsLost ?? null);
	if (editor.mode !== 'live' || !lost) return null;
	return (
		<div className="note danger" role="alert" data-note="drafts-lost">
			<Icon name="warn" />
			<div>
				<b>{lost.title}</b>
				<p>{lost.message}</p>
			</div>
		</div>
	);
}

/** caracms-cloud adversarial review, force-push note: `main` was rolled back past the last Publish; the sentence is the server's. */
function RolledBackNote() {
	const editor = useEditor();
	const rolled = useStore(editor.liveState, (s) => s.status?.mainRolledBack ?? null);
	if (editor.mode !== 'live' || !rolled) return null;
	return (
		<div className="note warn" role="alert" data-note="main-rolled-back">
			<Icon name="warn" />
			<div>
				<b>{rolled.title}</b>
				<p>{rolled.message}</p>
			</div>
		</div>
	);
}

/** The sentence as it came, with `link` as a link where it names it (or after it); the words are never changed. */
function withLink(message: string, link: string | null) {
	if (!link) return message;
	const a = (key: number) => (
		<a key={key} href={link} target="_blank" rel="noopener noreferrer">
			{link}
		</a>
	);
	const parts = message.split(link);
	if (parts.length === 1) return [message, ' ', a(0)];
	return parts.flatMap((part, i) => (i === 0 ? [part] : [a(i), part]));
}

function KeepNotes() {
	const editor = useEditor();
	const state = useStore(editor.keep, (k) => k.state);
	const error = useStore(editor.keep, (k) => k.error);
	if (state === 'refused') {
		return (
			<div className="note danger" role="alert" data-note="refused">
				<Icon name="warn" />
				<div>
					<b>The server didn't keep your latest changes</b>
					<p>It said: {error ?? 'the write was refused.'}</p>
					<p>Held in this browser.</p>
				</div>
			</div>
		);
	}
	if (state !== 'offline') return null;
	if (editor.mode === 'live') return <LiveOffline />;
	return (
		<div className="note danger" role="alert" data-note="offline">
			<Icon name="offline" />
			<div>
				<b>Can't reach the server</b>
				<p>Changes are only in this tab. Keep it open.</p>
				{/* M4: "Trying again in 12 s." and the unsent count. */}
				<p data-slot="retry-countdown" hidden />
				{/* M4: "Try now". */}
				<div className="acts" data-slot="try-now" hidden />
			</div>
		</div>
	);
}

/** Live mode's offline note (the mockup's #offline): the unsent count, the countdown and Try now. */
function LiveOffline() {
	const editor = useEditor();
	const n = useStore(editor.keep, (k) => k.unsent ?? 0);
	return (
		<div className="note danger" role="alert" data-note="offline">
			<Icon name="offline" />
			<div>
				<b>Can't reach the server</b>
				<p data-unsent={n}>
					{n > 0
						? `${n} change${n === 1 ? '' : 's'} only in this tab. Keep it open.`
						: 'Keep this tab open.'}
				</p>
				<OfflineExtras />
			</div>
		</div>
	);
}

/** The Recent strip at the foot of the pane (per browser, from the cookie: Decision 20). */
export function RecentStrip() {
	const editor = useEditor();
	const recent = useStore(editor.ui, (u) => u.recent);
	const documents = useStore(editor.documents);
	const current = useStore(editor.doc.state, (s) => docId(s.ref));
	const items = recent
		.map((id) => documents.find((d) => docId(d) === id))
		.filter((d): d is NonNullable<typeof d> => !!d && opensInEditor(d))
		.slice(0, 5);
	return (
		<div className="side-foot">
			{/* No visible label: the chips speak for themselves. Screen readers still hear "Recent". */}
			<div className="rchips" role="group" aria-label="Recent">
				{items.map((d) => (
					<button
						key={docId(d)}
						type="button"
						className={`rchip${docId(d) === current ? ' is-current' : ''}`}
						onClick={() => void editor.openDocument({ collection: d.collection, path: d.path })}
					>
						{d.label}
						{docId(d) === current ? <RecentMark /> : null}
						{editor.mode === 'live' ? <DocMarksView file={d.file} compact /> : null}
					</button>
				))}
			</div>
		</div>
	);
}

function RecentMark() {
	return useTooLong(true) ? (
		<span className="wmark" title="Too long for mobile">
			<Icon name="phone" size="xs" />
			<span className="sr">, too long for mobile</span>
		</span>
	) : null;
}

/** A document's parent label for crumbs (`Services`): see nav/search.ts. */
export { parentLabel } from '../nav/search.ts';
