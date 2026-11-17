/**
 * The open document's menu in its level header (the mockup's docMenuHTML; #home-menu,
 * #delete-locked): **View on the live site** (off for a document that isn't live yet)
 * and **Delete page…** (or Delete <a case study>…, Delete shared block…), which opens
 * the confirmation (dialogs.tsx). Delete is off, with the reason under it, for Home
 * ("The home page can't be deleted.") and while someone else is editing it ("Aoife is
 * editing Contact. It can be deleted once she's done."). A shared block still in use
 * opens the "still on N pages" dialog instead. Site Settings has no menu.
 *
 * Pre-M7 item 8: **Change address…** for a document with an address (a page, a case
 * study, a journal entry), off for Home or a collection's top page and while someone
 * else is editing it.
 *
 * Discard changes (live mode): **Discard changes…** (or Discard this new page…) while the
 * document is waiting to publish, which opens the confirmation; off, with the reason, while
 * someone else is editing it.
 *
 * M6c (G1): a document with no page of its own (a shared block, a fields collection
 * with no `urlBase`) has neither View on the live site nor Change address…, only Delete.
 *
 * `TitleNote` (caracms-cloud adversarial review, finding 15): a page or a shared block with
 * no title says so at the top of its level, with Rename… beside it (a case study's title is
 * the first field of its form, which says so itself: FormLevel.tsx → TitleField).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { displayName } from '../live/format.ts';
import { Icon } from '../shell/Icons.tsx';
import { NO_TITLE } from '../../../document-problems.ts';
import { docId, sameDoc } from '../../types.ts';
import { discardWording, singular } from './actions.ts';
import { openDialog } from './dialogs.tsx';

export function DocMenu({ label }: { label: string }) {
	const editor = useEditor();
	const ref = useStore(editor.doc.state, (s) => s.ref);
	const entry = useStore(editor.doc.state, (s) => s.entry);
	const title = useStore(editor.doc.state, (s) => s.document.title || s.entry.label);
	const documents = useStore(editor.documents);
	const access = useStore(editor.access);
	const waiting = useStore(editor.liveState, (s) => s.status?.waiting);
	const signedOut = useStore(editor.liveState, (s) => !!s.signedOut);
	const [open, setOpen] = useState(false);
	const menu = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const collection = editor.site.collections.find((c) => c.name === ref.collection);

	useEffect(() => {
		if (!open) return;
		menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
		const onDown = (event: MouseEvent) => {
			const target = event.target as Element | null;
			if (menu.current?.contains(target) || button.current?.contains(target)) return;
			setOpen(false);
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [open]);
	// Another document, another menu.
	useEffect(() => setOpen(false), [ref]);
	const over = useStore(editor.over, (o) => !!o);

	if (!collection || collection.kind === 'settings') return null;
	const shared = collection.kind === 'shared';
	const noPage = collection.urlBase === null;
	const pending = (waiting ?? []).find((w) => w.collection === ref.collection && w.path === ref.path && w.change === 'new');
	// Discard changes: this document is waiting to publish.
	const waitingHere = (waiting ?? []).find((w) => w.file === entry.file) ?? null;
	const isNew = !!pending;
	const listed = documents.find((d) => docId(d) === docId(ref));
	const home = sameDoc(ref, editor.site.home);
	const holder = access.lock === 'theirs' && access.holder ? displayName(access.holder.person) : null;
	const why = home ? "The home page can't be deleted." : holder ? `${holder} is editing ${title}. It can be deleted once they're done.` : access.deleted ? 'It has been deleted already.' : null;
	const top = collection.nested && ref.path === 'index';
	const moveWhy = top
		? home
			? 'Home is always at /.'
			: `It's the top of ${collection.label}, so its address is ${collection.label}'s.`
		: holder
			? `${holder} is editing it.`
			: access.held
				? 'Use mine or Discard mine first.'
				: signedOut
					? 'Sign in again first: its unsent changes would be lost.'
					: !entry.url
				? "It can't be opened, so its address can't change."
				: null;
	const close = () => {
		setOpen(false);
		button.current?.focus();
	};
	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === 'Escape') {
			// Closes the menu only; the editor's Esc would go up a level.
			event.preventDefault();
			event.stopPropagation();
			close();
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
			const at = items.indexOf(document.activeElement as HTMLButtonElement);
			items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
		}
	};
	const remove = () => {
		setOpen(false);
		// Edit in context, Decision 3: a slot's default stays, so a slot always has one.
		if (shared && listed?.slot && listed.default) openDialog(editor, { kind: 'is-default', ref });
		else if (shared && (listed?.usedOn?.length ?? 0) > 0) openDialog(editor, { kind: 'in-use', ref });
		else openDialog(editor, { kind: 'delete', ref });
	};
	return (
		<div style={{ position: 'relative' }} data-slot="page-menu">
			<button
				ref={button}
				type="button"
				className="ib"
				data-act="doc-menu"
				aria-label={label}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
			>
				<Icon name="more" />
			</button>
			{open ? (
				<div ref={menu} className="menu" role="menu" style={{ right: 0, top: 'calc(100% + 4px)' }} onKeyDown={onKey}>
					{/* A fields document's title is the first field of its form; the rest are renamed here. */}
					{collection.kind === 'fields' ? null : (
						<button type="button" role="menuitem" data-act="rename-document" disabled={access.readOnly} onClick={() => (setOpen(false), openDialog(editor, { kind: 'rename' }))}>
							<Icon name="pencil" />
							Rename…
						</button>
					)}
					{noPage ? null : (
						<>
							{/* Edit in context (Decision 7): open over a page, its own page is one step away. */}
							{over && entry.url ? (
								<button type="button" role="menuitem" data-act="show-own-page" onClick={() => (setOpen(false), void editor.showOwnPage())}>
									<Icon name="page" />
									Open its page
								</button>
							) : null}
							<button
								type="button"
								role="menuitem"
								disabled={isNew || !entry.url}
								onClick={() => {
									setOpen(false);
									if (entry.url) window.open(entry.url, '_blank', 'noopener');
								}}
							>
								<Icon name="ext" />
								View on the live site
							</button>
							{isNew ? <div className="why">Not live yet.</div> : null}
							<button type="button" role="menuitem" data-act="move-document" disabled={!!moveWhy} onClick={() => (setOpen(false), openDialog(editor, { kind: 'move', ref }))}>
								<Icon name="arrow-r" />
								Change address…
							</button>
							{moveWhy ? (
								<div className="why" data-why="move">
									{moveWhy}
								</div>
							) : null}
							<hr />
						</>
					)}
					{waitingHere ? (
						<>
							<button
								type="button"
								role="menuitem"
								data-act="discard-document"
								disabled={!!holder}
								onClick={() => (setOpen(false), openDialog(editor, { kind: 'discard', file: waitingHere.file }))}
							>
								<Icon name="undo" />
								{discardWording(waitingHere, editor.you, shared ? 'shared block' : singular(collection)).menu}
							</button>
							{holder ? (
								<div className="why" data-why="discard">
									{holder} is editing it.
								</div>
							) : null}
						</>
					) : null}
					<button type="button" role="menuitem" className="danger" data-act="delete-document" disabled={!!why} onClick={remove}>
						<Icon name="trash" />
						Delete {shared ? 'shared block' : singular(collection)}…
					</button>
					{why ? (
						<div className="why" data-why="delete">
							{why}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * The open document has no title (blanked, or read that way from its file): it's kept as it
 * is, isn't on the site, and Publish holds it back until it has one. Renaming it gives it one.
 */
export function TitleNote() {
	const editor = useEditor();
	const untitled = useStore(editor.doc.state, (s) => s.document.title.trim() === '');
	const readOnly = useStore(editor.access, (a) => a.readOnly);
	if (!untitled) return null;
	return (
		<div className="note warn tight" role="status" data-note="no-title">
			<Icon name="warn" />
			<div>
				<b>{NO_TITLE.note}</b>
				<p>Until it has one, it isn't on the site and Publish leaves it waiting.</p>
				<div className="acts">
					<button type="button" className="btn sm" data-act="rename-untitled" disabled={readOnly} onClick={() => openDialog(editor, { kind: 'rename' })}>
						Rename…
					</button>
				</div>
			</div>
		</div>
	);
}
