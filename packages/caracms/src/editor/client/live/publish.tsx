/**
 * The bar's waiting count and Publish, and their popovers (M4 Decisions 10, 12 and
 * 18; the mockup's pubHTML, waitingPop and historyPop: #waiting #nothing #publishing
 * #live #failed #blocked #history). Live mode only.
 *
 * - **The bar's button**: "3 waiting" with who, and Publish; "Publishing…" with the
 *   running bar; "Live · 14:12"; "Publish failed" with Try again; "Taking longer than
 *   usual" (runs-anywhere Decision 10: not live 15 minutes on, no failure known), with
 *   Try again when a redeployer is set; "Nothing waiting".
 *   Off while the server can't be reached or you're signed out.
 * - **The popover is the summary**: each waiting document, who changed it and when,
 *   "Editing now", uncommitted changes included (the status merges them), the merge
 *   notice where the draft was kept, then the final Publish button. Then publishing →
 *   live, or failed (or taking longer than usual) with Try again, or with the line that
 *   a developer can redeploy it when no redeployer is set (`hasRedeployer: false`;
 *   runs-anywhere Decision 11: no host's name).
 * - **History**: who published, when, which documents, and whether each went live,
 *   in the site's time zone, named once. Read when the waiting popover opens (on
 *   intent), so it's there when History is pressed, and the last read shows while
 *   it's read again.
 * - **Images without alt text** (M5b Decision 9; #publish-alt, #fix-alt-list,
 *   #fix-alt-locked): each waiting document with an image missing alt text is marked,
 *   naming each slot by its label (`WaitingView.missingAlt`, worked out by the server
 *   from the document as it will publish), with **Add alt text**, which opens the
 *   document on that field (a list row expanded, the alt input focused; a document
 *   someone else holds opens read-only with the field shown). The bar's count gets a
 *   warning dot. **Publish stays on and one click**: nothing here holds it back.
 * - **Held back** (caracms-cloud adversarial review, finding 15): a waiting document the
 *   reader would refuse (no title: `WaitingView.heldBack`) says so on its row ("Tiny won't
 *   be published: its title is empty."), with Add a title, which opens it. Publish sends the
 *   rest ("Publish 1 change"); with nothing else waiting it's off, and says why. What was
 *   held back is said again in the toast when Publish answers (editor.ts → publish).
 * - **Discard…** on each waiting document (Discard changes): the confirmation
 *   (documents/dialogs.tsx → `discard`) puts it back to what's live.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useEditor, useStore } from '../context.tsx';
import type { Editor } from '../editor.ts';
import { Icon } from '../shell/Icons.tsx';
import type { HistoryEntryView, MissingAltView, Person, StatusResponse, WaitingView } from '../../types.ts';
import { formKey, PAGE_SCOPE } from '../state/document-store.ts';
import { focusSidebarField } from '../preview/page-edit.ts';
import { clock, displayName, joinNames, samePerson, when, zoneLine } from './format.ts';
import { Avatar } from './marks.tsx';
import { docIcon } from '../nav/DocRow.tsx';
import { singular } from '../documents/actions.ts';
import { openDialog } from '../documents/dialogs.tsx';
import { NO_TITLE } from '../../../document-problems.ts';

const histories = new WeakMap<Editor, { entries: HistoryEntryView[]; timeZone: string } | null>();

/** Read the history (at most once in flight), keeping the last read for the next open. */
function readHistory(editor: Editor, set?: (h: { entries: HistoryEntryView[]; timeZone: string }) => void) {
	void editor.liveSession?.history().then((h) => {
		if (!h) return;
		histories.set(editor, h);
		set?.(h);
	});
}

/** The images without alt text across the waiting documents (a deleted one has none: the server leaves it out too). */
const altGaps = (waiting: readonly WaitingView[]): number => waiting.reduce((n, w) => n + (w.change === 'deleted' ? 0 : (w.missingAlt?.length ?? 0)), 0);

/**
 * Add alt text (Decision 9): open the document on the image's field. A list item opens its
 * row, expanded; the alt input is focused. A document someone else holds opens read-only
 * (M4's lock), its field shown but not focused.
 */
export async function openAtAlt(editor: Editor, item: Pick<WaitingView, 'collection' | 'path'>, gap: MissingAltView, options: { held?: boolean } = {}): Promise<void> {
	if (item.collection === null || item.path === null) return;
	editor.setPop(null);
	await editor.openDocument({ collection: item.collection, path: item.path });
	const session = editor.doc.get();
	const slot = gap.path.replace(/\.alt$/, '');
	if (gap.block === null && session.document.kind === 'sections') {
		// M6c (G2): a page field's image, in the page's own group at its document level.
		editor.view.update({ level: 'document', field: `${PAGE_SCOPE}.${slot}`, picked: false, pop: null });
	} else {
		const key = gap.block !== null && session.document.kind === 'sections' ? editor.doc.keyAt(gap.block) : formKey(session);
		if (!key) return;
		editor.openBlock(key, slot, { picked: false });
	}
	const held = () => !!options.held || editor.access.get().readOnly;
	let tries = 30;
	const attempt = () => {
		const shown = '#side .side-level:not([hidden])';
		const input = document.querySelector<HTMLInputElement>(`${shown} input[data-alt="${CSS.escape(slot)}"]`);
		const wrap = document.querySelector<HTMLElement>(`${shown} [data-path="${CSS.escape(slot)}"]`);
		if (wrap && held()) {
			// Someone else holds it: read-only, the field shown but not focused.
			wrap.scrollIntoView({ block: 'center' });
			return;
		}
		if (input && !input.disabled) {
			input.scrollIntoView({ block: 'center' });
			input.focus({ preventScroll: true });
			if (document.activeElement === input) return;
		}
		if (tries-- > 0) requestAnimationFrame(attempt);
		else if (!held()) focusSidebarField(slot);
	};
	requestAnimationFrame(attempt);
}

const people = (waiting: readonly WaitingView[]): Person[] => {
	const out: Person[] = [];
	for (const w of waiting) for (const e of w.editors) if (!out.some((p) => samePerson(p, e.person))) out.push(e.person);
	return out;
};

export function PublishButton() {
	const editor = useEditor();
	const status = useStore(editor.liveState, (s) => s.status);
	const reachable = useStore(editor.liveState, (s) => s.reachable);
	const signedOut = useStore(editor.liveState, (s) => s.signedOut);
	const keep = useStore(editor.keep, (k) => k.state);
	const pop = useStore(editor.view, (v) => v.pop);
	if (!status) return <span data-slot="publish" hidden />;
	const expanded = pop === 'waiting' || pop === 'history';
	const toggle = () => editor.setPop(expanded ? null : 'waiting');
	const n = status.waiting.length;
	const pub = status.publish;
	const common = { type: 'button' as const, 'data-slot': 'publish', 'aria-haspopup': 'dialog' as const, 'aria-expanded': expanded, onClick: toggle };
	if (pub.running || pub.state === 'publishing') {
		return (
			<button {...common} className="pub busy" data-pub="publishing">
				<span className="wt">Publishing…</span>
				<span className="pb off">Publish</span>
				<span className="prog" aria-hidden="true" />
			</button>
		);
	}
	if (pub.state === 'live' && !n && pub.record) {
		return (
			<button {...common} className="pub live" data-pub="live">
				<span className="wt">
					<Icon name="check" size="sm" />
					Live · {clock(pub.record.at, status.timeZone)}
				</span>
				<span className="pb off">Publish</span>
			</button>
		);
	}
	if ((pub.state === 'failed' || pub.state === 'slow') && !n) {
		return (
			<button {...common} className="pub fail" data-pub={pub.state}>
				<span className="wt">
					<Icon name="warn" size="sm" />
					{pub.state === 'slow' ? 'Taking longer than usual' : 'Publish failed'}
				</span>
				<span className={`pb${pub.canTryAgain ? '' : ' off'}`}>{pub.canTryAgain ? 'Try again' : 'Publish'}</span>
			</button>
		);
	}
	if (!n) {
		return (
			<button {...common} className="pub off" data-pub="nothing" aria-label="Nothing waiting. Nothing to publish">
				<span className="wt">Nothing waiting</span>
				<span className="pb">Publish</span>
			</button>
		);
	}
	const off = keep === 'offline' || !reachable || !!signedOut;
	// M5b Decision 9: images without alt text put a warning dot on the count; Publish stays on.
	const gaps = off ? 0 : altGaps(status.waiting);
	const gw = `${gaps} image${gaps === 1 ? '' : 's'} without alt text`;
	return (
		<button {...common} className={`pub${off ? ' off' : ''}`} data-pub="waiting" data-alt-gaps={gaps || undefined} aria-label={`${n} change${n === 1 ? '' : 's'} waiting${gaps ? `, ${gw}` : ''}. Publish`}>
			<span className="wt">
				<span className="avs">
					{people(status.waiting).map((p) => (
						<Avatar key={p.email} person={p} size="sm" />
					))}
				</span>
				<b>{n} waiting</b>
			</span>
			<span className="pb">
				Publish{' '}
				<span className="count" title={gaps ? gw : undefined}>
					{n}
					{gaps ? <span className="wdot" aria-hidden="true" data-dot="alt" /> : null}
				</span>
			</span>
		</button>
	);
}

/** A click outside a popover closes it (its trigger toggles it itself). */
function useOutside(close: () => void, trigger: string) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const onDown = (event: MouseEvent) => {
			const target = event.target as Element | null;
			if (!target || ref.current?.contains(target) || target.closest?.(trigger)) return;
			close();
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [close, trigger]);
	return ref;
}

function HistoryLink() {
	const editor = useEditor();
	return (
		<button type="button" className="linkbtn subtle" data-act="history" onClick={() => editor.setPop('history')}>
			<Icon name="history" size="sm" />
			History
		</button>
	);
}

export function WaitingPop() {
	const editor = useEditor();
	const status = useStore(editor.liveState, (s) => s.status);
	const reachable = useStore(editor.liveState, (s) => s.reachable);
	const signedOut = useStore(editor.liveState, (s) => s.signedOut);
	const keep = useStore(editor.keep, (k) => k.state);
	const [busy, setBusy] = useState(false);
	const [tryError, setTryError] = useState<string | null>(null);
	/** The last Publish press failed (a 502, the server away): said here, and Publish can be pressed again. */
	const [publishError, setPublishError] = useState<string | null>(null);
	const ref = useOutside(() => editor.setPop(null), '.pub');
	// On intent: the history, so it's there when History is pressed.
	useEffect(() => readHistory(editor), [editor]);
	if (!status) return null;
	const wrap = (body: ReactNode, width = 440) => (
		<div ref={ref} className="pop" role="dialog" aria-label="Waiting changes and Publish" data-pop="waiting" style={{ right: 8, width }}>
			{body}
		</div>
	);
	const n = status.waiting.length;
	// Finding 15: what Publish will send; the rest stays waiting.
	const going = status.waiting.filter((w) => !w.heldBack).length;
	const pub = status.publish;
	const record = pub.record;
	const names = joinNames(record?.titles ?? []);
	const by = record ? displayName(record.by) : '';

	if ((pub.running || pub.state === 'publishing') && !n) {
		return wrap(
			<>
				<div className="pop-h">
					<div>
						<h2>Publishing</h2>
						<p className="sub">{record ? `${names} going live.` : 'Going live.'}</p>
					</div>
				</div>
				<div className="pop-b">
					<div className="progress" role="progressbar" aria-label="Publishing" aria-valuetext="Publishing" />
					{record ? (
						<p className="field-help" style={{ marginBottom: 'var(--space-4)' }}>
							Started at {clock(record.at, status.timeZone)} by {by}.
						</p>
					) : null}
				</div>
				<div className="pop-f">
					<HistoryLink />
					<span className="sp" />
					<button type="button" className="btn lg" disabled>
						Publish
					</button>
				</div>
			</>,
		);
	}
	if (pub.state === 'live' && !n && record) {
		return wrap(
			<>
				<div className="pop-h">
					<div>
						<h2 style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--status-live)' }}>
							<Icon name="check" />
							Live
						</h2>
						<p className="sub">
							Published at {clock(record.at, status.timeZone)} by {by}: {names}.
						</p>
					</div>
				</div>
				<div className="pop-b">
					<div className="empty" style={{ marginBottom: 'var(--space-4)' }}>
						<b>Nothing waiting</b>
					</div>
				</div>
				<div className="pop-f">
					<HistoryLink />
					<span className="sp" />
					<a className="btn" href="/" target="_blank" rel="noopener">
						<Icon name="ext" size="sm" />
						View the live site
					</a>
				</div>
			</>,
		);
	}
	if ((pub.state === 'failed' || pub.state === 'slow') && !n) {
		const slow = pub.state === 'slow';
		const published = record ? `${names} ${record.titles.length === 1 ? 'was' : 'were'} published at ${clock(record.at, status.timeZone)}` : null;
		return wrap(
			<>
				<div className="pop-h">
					<div>
						<h2 style={{ color: 'var(--status-danger)' }}>{slow ? 'This publish is taking longer than usual' : "The publish didn't go live"}</h2>
						<p className="sub">
							{slow ? `${published ? `${published}. ` : ''}It may have failed.` : `${published ? `${published}, but` : 'The'} the live site couldn't be updated.`}
						</p>
					</div>
				</div>
				<div className="pop-b">
					{pub.canTryAgain ? (
						<div className="note danger" data-note="try-again">
							<Icon name="warn" />
							<div>
								<b>Try again updates the live site</b>
								<p>If it fails twice, tell your developer.</p>
								{tryError ? <p>It didn't work: {tryError}</p> : null}
							</div>
						</div>
					) : (
						<div className="note danger" data-note="no-token">
							<Icon name="warn" />
							<div>
								<b>A developer can redeploy it</b>
							</div>
						</div>
					)}
				</div>
				<div className="pop-f">
					<HistoryLink />
					<span className="sp" />
					{pub.canTryAgain ? (
						<button
							type="button"
							className="btn lg ink"
							data-act="try-again"
							disabled={busy}
							onClick={async () => {
								setBusy(true);
								setTryError(null);
								const r = await editor.tryAgain();
								setBusy(false);
								if (!r.ok) setTryError(r.error ?? 'the server said no.');
							}}
						>
							Try again
						</button>
					) : null}
				</div>
			</>,
		);
	}
	if (!n) {
		return wrap(
			<>
				<div className="pop-h">
					<div>
						<h2>Nothing to publish</h2>
						<p className="sub">Everything is live.</p>
					</div>
				</div>
				<div className="pop-f">
					<HistoryLink />
					<span className="sp" />
					<button type="button" className="btn lg" disabled>
						Publish
					</button>
				</div>
			</>,
			380,
		);
	}
	if (keep === 'offline' || !reachable || signedOut) {
		return wrap(
			<>
				<div className="pop-h">
					<div>
						<h2>
							{n} change{n === 1 ? '' : 's'} waiting
						</h2>
						<p className="sub">
							{signedOut ? 'Publishing needs you signed in.' : 'Publishing needs the server.'}
						</p>
					</div>
				</div>
				<div className="pop-f">
					<HistoryLink />
					<span className="sp" />
					<button type="button" className="btn lg" disabled>
						Publish
					</button>
				</div>
			</>,
			380,
		);
	}
	return wrap(
		<>
			<div className="pop-h">
				<div>
					<h2>
						{n} change{n === 1 ? '' : 's'} waiting
					</h2>
				</div>
				<span className="r">{whoCounts(status.waiting)}</span>
			</div>
			<div className="pop-b">
				<ul className="wlist">
					{status.waiting.map((w) => (
						<WaitItem key={w.file} item={w} status={status} />
					))}
				</ul>
				{going === 0 ? (
					<p className="field-help" data-note="all-held">
						Nothing can be published until {n === 1 ? 'it has' : 'they have'} what's missing.
					</p>
				) : null}
				{publishError ? (
					<div className="note danger tight" role="alert" data-note="publish-failed">
						<Icon name="warn" />
						<div>
							<b>It didn't publish</b>
							<p>Nothing went live. ({publishError})</p>
						</div>
					</div>
				) : null}
			</div>
			<div className="pop-f">
				<HistoryLink />
				<span className="sp" />
				<button
					type="button"
					className="btn lg publish"
					data-act="publish"
					disabled={busy || going === 0}
					onClick={async () => {
						setBusy(true);
						setPublishError(null);
						const r = await editor.publish();
						setBusy(false);
						if (!r.ok) setPublishError(r.error ?? 'the server said no.');
					}}
				>
					{going ? `Publish ${going} change${going === 1 ? '' : 's'}` : 'Publish'}
				</button>
			</div>
		</>,
	);
}

function whoCounts(waiting: readonly WaitingView[]): string {
	const counts = new Map<string, { person: Person; n: number }>();
	for (const w of waiting)
		for (const e of w.editors) {
			const k = e.person.email.toLowerCase();
			const c = counts.get(k) ?? { person: e.person, n: 0 };
			c.n += 1;
			counts.set(k, c);
		}
	return [...counts.values()]
		.sort((a, b) => b.n - a.n)
		.map((c) => `${displayName(c.person)} ${c.n}`)
		.join(' · ');
}

function WaitItem({ item, status }: { item: WaitingView; status: StatusResponse }) {
	const editor = useEditor();
	const others = item.editingNow.filter((p) => !samePerson(p, status.you));
	const editing = item.editingNow.length > 0;
	const notice = status.notices.find((n) => n.kind === 'draft-kept' && n.file === item.file);
	const collection = editor.site.collections.find((c) => c.name === item.collection);
	return (
		<li className="wi" data-waiting={item.file}>
			<div className="wi-top">
				<Icon name={collection ? docIcon(collection) : 'page'} />
				<b>{item.title}</b>
				{editing ? <span className="chip waiting">Editing now</span> : null}
				{/* M5a: a document that isn't on the live site yet, or that leaves it at this Publish. */}
				{item.change === 'deleted' ? (
					<span className="chip danger" data-change="deleted">
						Deleted
					</span>
				) : item.movedFrom ? (
					<span className="chip waiting" data-change="moved">
						Moved
					</span>
				) : item.change === 'new' ? (
					<span className="chip waiting" data-change="new">
						New {collection ? singular(collection) : 'page'}
					</span>
				) : null}
				<span className="when">
					{item.editors.map((e) => (
						<Avatar key={e.person.email} person={e.person} size="sm" />
					))}
					{item.editors.map((e) => displayName(e.person)).join(', ')}
					{item.changedAt ? ` · ${when(item.changedAt, status.timeZone, status.now)}` : ''}
				</span>
			</div>
			{item.change === 'deleted' ? <div className="wi-what">It leaves the live site at the next Publish.</div> : null}
			{item.movedFrom ? (
				<div className="wi-what" data-moved-from={item.movedFrom}>
					{item.movedRedirect ? `${item.movedFrom} redirects here.` : `Moved from ${item.movedFrom}.`}
				</div>
			) : null}
			{collection?.kind === 'settings' ? (
				<div className="chips">
					<span className="chip live" data-chip="applies">
						<Icon name="bolt" size="xs" />
						Sign-in and branding already apply
					</span>
				</div>
			) : null}
			{others.length ? (
				<div className="wi-what">
					{joinNames(others.map(displayName))} {others.length === 1 ? 'is' : 'are'} still in it: it goes out as it stands, and they're told.
				</div>
			) : null}
			{notice ? (
				<div className="note warn tight" data-note="draft-kept">
					<Icon name="warn" />
					<div>
						<b>{item.title} was also changed outside the editor.</b>
						<p>Your draft was kept; check it before publishing.</p>
					</div>
				</div>
			) : null}
			{item.heldBack ? <HeldBackNote item={item} /> : null}
			{item.change !== 'deleted' && item.missingAlt?.length ? <AltGaps item={item} held={others} /> : null}
			<div className="wi-acts">
				<button type="button" className="linkbtn subtle" data-act="discard" aria-label={`Discard the unpublished changes to ${item.title}`} onClick={() => openDialog(editor, { kind: 'discard', file: item.file })}>
					Discard…
				</button>
			</div>
		</li>
	);
}

/** Finding 15: a waiting document Publish will leave waiting, and why, with the way to fix it. */
function HeldBackNote({ item }: { item: WaitingView }) {
	const editor = useEditor();
	const untitled = item.heldBack === NO_TITLE.reason;
	const open = async () => {
		if (item.collection === null || item.path === null) return;
		editor.setPop(null);
		await editor.openDocument({ collection: item.collection, path: item.path });
		// A form's title is its first field; a page or a shared block is renamed.
		requestAnimationFrame(() => {
			const input = document.querySelector<HTMLInputElement>('#side .side-level:not([hidden]) input[data-path="title"]');
			if (input && !input.disabled) input.focus();
		});
	};
	return (
		<div className="note warn tight" data-note="held-back">
			<Icon name="warn" />
			<div>
				<b>
					{item.title} won't be published: {item.heldBack}.
				</b>
				<p>It stays waiting. Publish sends the rest.</p>
				{untitled && item.collection !== null ? (
					<div className="acts">
						<button type="button" className="btn sm" data-act="add-title" onClick={() => void open()}>
							Add a title
						</button>
					</div>
				) : null}
			</div>
		</div>
	);
}

/** One waiting document's images without alt text (#publish-alt), each with Add alt text. It doesn't hold the Publish back. */
function AltGaps({ item, held }: { item: WaitingView; held: Person[] }) {
	const editor = useEditor();
	const gaps = item.missingAlt;
	const fix = (gap: MissingAltView) => (
		<button type="button" className="btn sm" data-act="fix-alt" data-alt-path={gap.path} onClick={() => void openAtAlt(editor, item, gap, { held: held.length > 0 })}>
			Add alt text
		</button>
	);
	const heldLine = held.length ? (
		<p data-held="">
			{joinNames(held.map(displayName))} {held.length === 1 ? 'is' : 'are'} editing {item.title}, so it opens read-only for now.
		</p>
	) : null;
	return (
		<div className="note warn tight" data-slot="alt-text" data-note="alt-text">
			<Icon name="image" />
			{gaps.length === 1 ? (
				<div>
					<b>{gaps[0]!.label} has no alt text</b>
					<p>Doesn't block Publish.</p>
					{heldLine}
					<div className="acts">{fix(gaps[0]!)}</div>
				</div>
			) : (
				<div>
					<b>{gaps.length} images have no alt text</b>
					<p>Doesn't block Publish.</p>
					{heldLine}
					<div className="alt-rows">
						{gaps.map((gap) => (
							<div key={gap.path + (gap.block ?? '')} className="alt-row" data-alt-row={gap.path}>
								<span className="t">{gap.label}</span>
								{fix(gap)}
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

export function HistoryPop() {
	const editor = useEditor();
	const [history, setHistory] = useState(() => histories.get(editor) ?? null);
	const status = useStore(editor.liveState, (s) => s.status);
	const ref = useOutside(() => editor.setPop(null), '.pub');
	// Read again when opened (at most once a minute on the server); the last read shows meanwhile.
	useEffect(() => readHistory(editor, setHistory), [editor]);
	const timeZone = history?.timeZone ?? status?.timeZone ?? 'UTC';
	const now = status?.now ?? new Date().toISOString();
	const entries = history?.entries ?? [];
	return (
		<div ref={ref} className="pop" role="dialog" aria-label="Publish history" data-pop="history" style={{ right: 8, width: 480 }}>
			<div className="pop-h">
				<button type="button" className="ib" aria-label="Back to waiting changes" onClick={() => editor.setPop('waiting')}>
					<Icon name="chev-l" />
				</button>
				<div>
					<h2>Publish history</h2>
					<p className="sub">{zoneLine(timeZone)}</p>
				</div>
			</div>
			<div className="pop-b">
				{history && entries.length === 0 ? (
					<div className="empty" style={{ marginBottom: 'var(--space-4)' }}>
						<b>Nothing published yet</b>
					</div>
				) : (
					<table className="hist">
						<tbody>
							{entries.map((h) => (
								<tr key={h.commit} data-history={h.commit}>
									<td className="when">{when(h.at, timeZone, now)}</td>
									<td className="who">{h.by ? <span><Avatar person={h.by} size="sm" />{displayName(h.by)}</span> : null}</td>
									<td className="docs">{joinNames(h.titles)}</td>
									<td className="st">
										{h.state === 'live' ? (
											<span className="chip live">
												<Icon name="check" size="xs" />
												Live
											</span>
										) : h.state === 'failed' ? (
											<span className="chip danger">
												<Icon name="warn" size="xs" />
												Failed
											</span>
										) : h.state === 'slow' ? (
											<span className="chip danger" data-chip="slow">
												<Icon name="warn" size="xs" />
												Taking longer than usual
											</span>
										) : (
											<span className="chip waiting">Publishing</span>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
			{history ? null : (
				<div className="pop-f">
					<span className="fine">Reading the history…</span>
				</div>
			)}
		</div>
	);
}
