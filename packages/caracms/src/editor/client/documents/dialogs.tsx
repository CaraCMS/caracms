/**
 * The dialogs for creating and deleting documents (M5a Decisions 11 and 12; the
 * mockup's #new-page, #new-group, #address-taken, #group-page, #new-case,
 * #new-shared, #delete-page, #delete-parent, #shared-delete), in the editor's
 * `#modal-root`. One at a time, from `dialogOf(editor)`:
 *
 *   openDialog(editor, { kind: 'new', collection, inside?, at?, folder? })   New page / + New (folder: New page in <Folder>)
 *   openDialog(editor, { kind: 'new-shared' })                      + New shared block
 *   openDialog(editor, { kind: 'delete', ref })                     Delete page… (the confirmation)
 *   openDialog(editor, { kind: 'in-use', ref, usedOn? })            a shared block still used
 *   openDialog(editor, { kind: 'move', ref })                       Change address… (pre-M7 item 8)
 *   openDialog(editor, { kind: 'rename' })                          Rename… on the open document
 *   openDialog(editor, { kind: 'replace', key })                    Replace… on a file (M6c G4, media/ReplaceDialog.tsx) or an image (media/ImageReplaceDialog.tsx)
 *   openDialog(editor, { kind: 'discard', file })                   Discard changes… (live mode: back to what's live)
 *
 * Esc closes the dialog only (the editor's own Esc, going up a level, doesn't run).
 * Addresses are shown before creating, made by slug.ts as the server makes them, and
 * pre-checked with `addressProblem`; whatever the server still refuses, its own
 * sentence shows on the field.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { INDEX_MESSAGE, NO_ADDRESS_MESSAGE, RESERVED_SLUG, addressProblem, slugify } from '../../../slug.ts';
import { documentsNoun, holdsMessage } from '../../../held.ts';
import { useEditor, useStore } from '../context.tsx';
import type { Editor } from '../editor.ts';
import { blockIcon } from '../block-list/summary.ts';
import { docIcon } from '../nav/DocRow.tsx';
import { Icon } from '../shell/Icons.tsx';
import { createStore, type Store } from '../state/store.ts';
import type { CreateDeleteRefusal, DocRef, ListedDocument } from '../../types.ts';
import { INSIDE_CLOSE, InsidePicker } from './InsidePicker.tsx';
import { addressFor, addressesMoving, andList, createDocument, deleteDocument, discardWording, insideOptions, moveDocument, pagesUnder, singular } from './actions.ts';
import { filesLabel, inboxFor } from '../inbox/store.ts';
import { ImageReplaceDialog } from '../media/ImageReplaceDialog.tsx';
import { ReplaceDialog } from '../media/ReplaceDialog.tsx';
import { isFileKey } from '../../../files.ts';

export type Dialog =
	| { kind: 'new'; collection: string; inside?: string; at?: string; folder?: { id: string; name: string } }
	| { kind: 'new-shared' }
	| { kind: 'delete'; ref: DocRef }
	| { kind: 'in-use'; ref: DocRef; usedOn?: CreateDeleteRefusal['usedOn'] }
	/** Edit in context, Decision 3: a slot's default, which can't be deleted. */
	| { kind: 'is-default'; ref: DocRef }
	/** Pre-M7 item 8: Change address…, in the language of New page. */
	| { kind: 'move'; ref: DocRef }
	/** Rename… on the open document: its title, the name the editor lists it by. */
	| { kind: 'rename' }
	/** M6 Decision 9: a submission's Delete…, permanent, so it asks first (the mockup's #submission-delete). */
	| { kind: 'sub-delete'; id: string; who: string; files: number }
	/** M6c G4 Decision 9: Replace… on a file in the library (its key). */
	| { kind: 'replace'; key: string }
	/** Arrange pages (Decision 15): leaving the screen with something arranged; `go` leaves, dropping it. */
	| { kind: 'arrange-leave'; go: () => void }
	/** Discard changes (live mode): a waiting document, by its file, back to what's live. */
	| { kind: 'discard'; file: string };

const dialogs = new WeakMap<Editor, Store<Dialog | null>>();

export function dialogOf(editor: Editor): Store<Dialog | null> {
	let store = dialogs.get(editor);
	if (!store) dialogs.set(editor, (store = createStore<Dialog | null>(null)));
	return store;
}
export const openDialog = (editor: Editor, dialog: Dialog) => {
	editor.setPop(null);
	dialogOf(editor).set(dialog);
};
export const closeDialog = (editor: Editor) => dialogOf(editor).set(null);

/** Whichever dialog is open. Mounted once, in the shell's `#modal-root`. */
export function DocumentDialogs() {
	const editor = useEditor();
	const dialog = useStore(dialogOf(editor));
	if (!dialog) return null;
	switch (dialog.kind) {
		case 'new':
			return <NewDocument key={`${dialog.collection}:${dialog.inside ?? ''}:${dialog.at ?? ''}:${dialog.folder?.id ?? ''}`} {...dialog} />;
		case 'new-shared':
			return <NewShared />;
		case 'delete':
			return <DeleteDocument key={`${dialog.ref.collection}/${dialog.ref.path}`} docRef={dialog.ref} />;
		case 'in-use':
			return <InUse docRef={dialog.ref} usedOn={dialog.usedOn} />;
		case 'is-default':
			return <IsDefault docRef={dialog.ref} />;
		case 'move':
			return <MoveDocument key={`${dialog.ref.collection}/${dialog.ref.path}`} docRef={dialog.ref} />;
		case 'rename':
			return <RenameDocument />;
		case 'sub-delete':
			return <DeleteSubmission key={dialog.id} {...dialog} />;
		case 'replace':
			return isFileKey(dialog.key) ? <ReplaceDialog key={dialog.key} fileKey={dialog.key} /> : <ImageReplaceDialog key={dialog.key} imageKey={dialog.key} />;
		case 'arrange-leave':
			return <LeaveArrange go={dialog.go} />;
		case 'discard':
			return <DiscardChanges key={dialog.file} file={dialog.file} />;
	}
}

/**
 * A dialog's tone, by its label (the editor restyle, Decision 2): danger when it loses or deletes
 * something, warn when it refuses (the thing can't be deleted yet), none otherwise. The tone's
 * class draws the needs-you frame. A new dialog takes a tone by the same test.
 */
const TONES: Record<string, 'danger' | 'warn'> = { delete: 'danger', 'sub-delete': 'danger', discard: 'danger', 'arrange-leave': 'danger', 'in-use': 'warn', holds: 'warn', 'is-default': 'warn' };

/** The dialog frame: the scrim, focus on its first control, Esc closing it alone, focus back where it was. */
/**
 * `returnTo`: where focus goes when the dialog closes and no control opened it (the browser's
 * Back, say, leaves it on the page body); otherwise it goes back to the control that did.
 */
export function Frame(props: { alert?: boolean; label: string; describedBy?: string; returnTo?: () => HTMLElement | null; children: ReactNode }) {
	const editor = useEditor();
	const box = useRef<HTMLDivElement>(null);
	const returnTo = useRef(props.returnTo);
	returnTo.current = props.returnTo;
	useEffect(() => {
		const before = document.activeElement as HTMLElement | null;
		const first =
			box.current?.querySelector<HTMLElement>('[data-autofocus]') ??
			box.current?.querySelector<HTMLElement>('input:not([disabled]),select:not([disabled]),[role="radio"],button.btn:not([disabled])');
		first?.focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				// Closes the dialog only: the editor's Esc (up a level) and the picker's don't run.
				event.preventDefault();
				event.stopImmediatePropagation();
				// An open Inside picker closes instead, and the dialog stays.
				const picker = box.current?.querySelector('[data-inside-open]');
				if (picker) picker.dispatchEvent(new Event(INSIDE_CLOSE));
				else closeDialog(editor);
			} else if (event.key === 'Tab' && box.current) {
				// Keep focus inside the dialog.
				const items = [...box.current.querySelectorAll<HTMLElement>('input:not([disabled]),select:not([disabled]),button:not([disabled])')];
				const at = items.indexOf(document.activeElement as HTMLElement);
				if (event.shiftKey && at <= 0) {
					event.preventDefault();
					items.at(-1)?.focus();
				} else if (!event.shiftKey && at === items.length - 1) {
					event.preventDefault();
					items[0]?.focus();
				}
			}
		};
		window.addEventListener('keydown', onKey, true);
		return () => {
			window.removeEventListener('keydown', onKey, true);
			const opener = before?.isConnected && before !== document.body ? before : (returnTo.current?.() ?? null);
			if (opener?.isConnected) opener.focus({ preventScroll: true });
		};
	}, [editor]);
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && closeDialog(editor)}>
			<div ref={box} className={TONES[props.label] ? `dialog ${TONES[props.label]}` : 'dialog'} role={props.alert ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="dlg-h" aria-describedby={props.describedBy} data-dialog={props.label}>
				{props.children}
			</div>
		</div>
	);
}

function Err({ id, text }: { id: string; text: string | null }) {
	if (!text) return null;
	return (
		<p className="field-err" id={id} role="alert">
			<Icon name="warn" size="sm" />
			<span>{text}</span>
		</p>
	);
}

// ── New page, + New ──────────────────────────────────────────────────────────

const NEW_GROUP = '__new';

function NewDocument(props: { collection: string; inside?: string; at?: string; folder?: { id: string; name: string } }) {
	const editor = useEditor();
	const documents = useStore(editor.documents);
	const collection = editor.site.collections.find((c) => c.name === props.collection);
	const at = props.at ?? null;
	const atLabel = at ? (insideOptions(collection ?? { name: props.collection, urlBase: '/' }, documents).find((o) => o.path === at)?.name ?? at) : null;
	const [name, setName] = useState(atLabel ?? '');
	const [inside, setInside] = useState(props.inside ?? '');
	const [group, setGroup] = useState('');
	/** The address's last part as typed by hand (null: it follows the name). */
	const [part, setPart] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const options = useMemo(() => (collection?.nested ? insideOptions(collection, documents) : []), [collection, documents]);
	if (!collection) return null;
	const nested = collection.nested;
	const what = singular(collection);
	// M6c (G1): a collection with no pages of its own makes a file from the name, and shows no address.
	const pageless = collection.urlBase === null;
	const newGroup = nested && !at && inside === NEW_GROUP;
	const folder = at ? '' : nested ? (newGroup ? slugify(group) : inside) : '';
	const last = at ? at : slugify(part ?? name);
	const path = at ? at : folder ? `${folder}/${last}` : last;
	const url = addressFor(collection, path);
	const base = addressFor(collection, folder ? `${folder}/` : '') ?? '/';
	// What's wrong before asking the server (the same rules it applies).
	const local = (() => {
		if (!name.trim()) return null;
		if (newGroup && !slugify(group)) return group.trim() ? NO_ADDRESS_MESSAGE : null;
		if (!last) return NO_ADDRESS_MESSAGE;
		if (path.split('/').includes(RESERVED_SLUG)) return INDEX_MESSAGE;
		const existing = documents.find((d) => d.collection === collection.name && d.path === path);
		if (existing) return url ? `There's already a ${what} at ${url}` : `There's already a ${what} called “${existing.label}”`;
		return url ? (addressProblem(url, collection.name, editor.site.collections, documents, editor.site.codeRoutes)?.message ?? null) : null;
	})();
	const shown = error ?? local;
	const blocked = !name.trim() || !last || (newGroup && !slugify(group)) || !!local || busy;
	const create = async () => {
		if (blocked) return;
		setBusy(true);
		setError(null);
		const answer = await createDocument(editor, { collection: collection.name, path, title: name.trim(), ...(props.folder ? { folder: props.folder.id } : {}) });
		setBusy(false);
		if (answer.ok) closeDialog(editor);
		else setError(answer.error);
	};
	const kids = at ? pagesUnder(collection.name, at, documents) : [];
	return (
		<Frame label="new">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void create();
				}}
			>
				<h2 id="dlg-h">{at ? `A page at ${url}` : props.folder ? `New page in ${props.folder.name}` : `New ${what}`}</h2>
				{editor.mode === 'live' ? <p>Nobody sees it until the next Publish.</p> : null}
				{at && kids.length ? (
					<div className="note" style={{ margin: 'var(--space-4) 0 0' }}>
						<Icon name="folder" />
						<div>
							<b>{atLabel} becomes a page</b>
							<p>
								{andList(kids.map((k) => k.label))} stay{kids.length === 1 ? 's' : ''} under it, at the same address{kids.length === 1 ? '' : 'es'}.
							</p>
						</div>
					</div>
				) : null}
				{props.folder ? (
					<div className="note" style={{ margin: 'var(--space-4) 0 0' }} data-note="folder">
						<Icon name="folder" />
						<div>
							<b>It goes at the end of {props.folder.name}</b>
							<p>Its address is at this level: folders aren’t in addresses.</p>
						</div>
					</div>
				) : null}
				{nested && !at && !props.folder ? (
					<div className="field">
						<label className="field-label" htmlFor="np-inside">
							Inside
						</label>
						<InsidePicker id="np-inside" options={options} value={inside} newGroup={NEW_GROUP} onChange={(v) => (setInside(v), setError(null))} />
					</div>
				) : null}
				{newGroup ? (
					<div className="field">
						<label className="field-label" htmlFor="np-group">
							Group name
						</label>
						<input className="input" id="np-group" value={group} placeholder="e.g. Workshops" autoComplete="off" onChange={(e) => (setGroup(e.target.value), setError(null))} />
					</div>
				) : null}
				<div className="field">
					<label className="field-label" htmlFor="np-name">
						{newGroup ? 'First page' : 'Name'}
					</label>
					<input
						className="input"
						id="np-name"
						data-autofocus=""
						value={name}
						placeholder={nested ? 'e.g. Packaging' : 'Name'}
						autoComplete="off"
						aria-invalid={shown ? true : undefined}
						aria-describedby={shown ? 'np-err' : undefined}
						onChange={(e) => (setName(e.target.value), setError(null))}
					/>
				</div>
				{pageless ? (
					<Err id="np-err" text={shown} />
				) : (
				<div className="field">
					<p className="urlpre" style={{ marginTop: 0 }} data-address={url ?? ''}>
						<Icon name="page" size="xs" />
						<span>
							Its address:{' '}
							<span className="mono">
								{editor.site.host}
								{at ? <b>{url}</b> : (
									<>
										{base}
										<b>{last || '…'}</b>
									</>
								)}
							</span>
						</span>
						{at || part !== null ? null : (
							<button type="button" className="linkbtn subtle" data-act="edit-address" onClick={() => setPart(last)}>
								Change
							</button>
						)}
					</p>
					{part !== null ? (
						<>
							<label className="sub-label" htmlFor="np-part">
								The address's last part
							</label>
							<input className="input mono" id="np-part" value={part} autoComplete="off" spellCheck={false} onChange={(e) => (setPart(e.target.value), setError(null))} />
						</>
					) : null}
					<Err id="np-err" text={shown} />
				</div>
				)}
				<div className="acts">
					<button type="button" className="btn" onClick={() => closeDialog(editor)}>
						Cancel
					</button>
					<button type="submit" className="btn ink" data-act="create" disabled={blocked}>
						{newGroup ? 'Create group and page' : `Create ${what}`}
					</button>
				</div>
			</form>
		</Frame>
	);
}

// ── Change address… (pre-M7 item 8) ─────────────────────────────────────────

/**
 * A document's new address: for nested Pages the group it sits in ("Inside", New page's
 * select, with New group…) and the address's last part, shown whole as it's typed, with
 * New page's rules checked before asking the server.
 *
 * **Everything under it moves with it** (collections under pages, Decision 9): the pages
 * under it at any depth, and the documents of a collection it (or a page under it) holds.
 * Then the dialog lists every address that changes ("Its 1 page moves with it",
 * "Its 24 journal entries move with it", the collection's own word for its documents), warns about a route of the site's own code under
 * the old address (it doesn't move), and has one tick for the lot. A page with nothing
 * under it keeps the single-page dialog.
 *
 * "Leave a redirect from …" ("Leave redirects from the old addresses" for several), ticked
 * to start with, says whether the old addresses redirect; it shows only when there's one to
 * leave (a live address, not one an earlier move since the last Publish already redirects).
 */
function MoveDocument({ docRef }: { docRef: DocRef }) {
	const editor = useEditor();
	const documents = useStore(editor.documents);
	const waiting = useStore(editor.liveState, (st) => st.status?.waiting);
	const doc = documents.find((d) => d.collection === docRef.collection && d.path === docRef.path);
	const collection = editor.site.collections.find((c) => c.name === docRef.collection);
	const slash = docRef.path.lastIndexOf('/');
	const [inside, setInside] = useState(slash === -1 ? '' : docRef.path.slice(0, slash));
	const [group, setGroup] = useState('');
	const [part, setPart] = useState(docRef.path.slice(slash + 1));
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [redirect, setRedirect] = useState(true);
	// Every page but this one and the pages under it: a page can't go under itself.
	const options = useMemo(() => (collection?.nested ? insideOptions(collection, documents).filter((o) => o.path !== docRef.path && !o.path.startsWith(`${docRef.path}/`)) : []), [collection, documents, docRef.path]);
	if (!doc || !collection || !doc.url) return null;
	const nested = collection.nested;
	const newGroup = nested && inside === NEW_GROUP;
	const folder = nested ? (newGroup ? slugify(group) : inside) : '';
	// As in New page: what's typed becomes an address part (`High-street roaster` → `high-street-roaster`).
	const last = slugify(part);
	const path = folder ? `${folder}/${last}` : last;
	const url = addressFor(collection, path);
	const base = addressFor(collection, folder ? `${folder}/` : '') ?? '/';
	const same = path === docRef.path;
	const moving = addressesMoving(editor.site.collections, docRef, path, documents);
	const many = moving.length > 1;
	const others = documents.filter((d) => !moving.some((m) => m.doc === d));
	// New page's rules, before asking the server (it applies the same, and checks every address that changes).
	const local = (() => {
		if (same) return null;
		if (newGroup && !slugify(group)) return group.trim() ? NO_ADDRESS_MESSAGE : null;
		if (!last) return part.trim() ? NO_ADDRESS_MESSAGE : null;
		if (path.split('/').includes(RESERVED_SLUG)) return INDEX_MESSAGE;
		return url ? (addressProblem(url, collection.name, editor.site.collections, others, editor.site.codeRoutes)?.message ?? null) : null;
	})();
	const shown = error ?? local;
	const blocked = same || !last || (newGroup && !slugify(group)) || !!local || busy;
	// Made since the last Publish: nobody has its address yet. Moved since then: its live address is the one it came from,
	// and its redirect from there is there already, following this move.
	const pendingOf = (d: ListedDocument) => (waiting ?? []).find((w) => w.collection === d.collection && w.path === d.path && (w.change === 'new' || !!w.movedFrom));
	const pending = pendingOf(doc);
	const liveAddress = pending ? (pending.movedFrom ?? null) : doc.url;
	const choose = many ? moving.some((m) => !pendingOf(m.doc)) : !pending;
	const host = editor.site.host;
	const confirm = async () => {
		if (blocked) return;
		setBusy(true);
		setError(null);
		const answer = await moveDocument(editor, docRef, path, doc.label, !choose || redirect);
		setBusy(false);
		if (answer.ok) closeDialog(editor);
		else setError(answer.error);
	};
	const publish = editor.mode === 'live' ? ' Goes live at the next Publish.' : '';
	const intro = !many && liveAddress && !choose ? `${liveAddress} will redirect here.${publish}` : null;
	// What moves with it: the pages under it, then each held collection's documents.
	const under = moving.filter((m) => !m.held && m.doc !== doc);
	const heldBy = new Map<string, number>();
	for (const m of moving) if (m.held) heldBy.set(m.doc.collection, (heldBy.get(m.doc.collection) ?? 0) + 1);
	const labelOf = (name: string) => editor.site.collections.find((c) => c.name === name)?.label ?? name;
	// "Its 1 page moves with it." "Its 24 journal entries move with it." "Its 2 pages and 24 journal entries move with it."
	const heldParts = [...heldBy].map(([name, n]) => `${n} ${n === 1 ? singular({ kind: 'sections', nested: false, label: labelOf(name) }) : documentsNoun(labelOf(name))}`);
	const parts = [...(under.length ? [`${under.length} page${under.length === 1 ? '' : 's'}`] : []), ...heldParts];
	if (parts.length) parts[0] = `Its ${parts[0]}`;
	const one = moving.length === 2 && parts.length === 1;
	const withIt = `${andList(parts)} move${one ? 's' : ''} with it.`;
	// A route of the site's own code under the old address stays where it is (Decision 10).
	const oldBase = `${doc.url.replace(/\/+$/, '')}/`;
	const routes = many ? (editor.site.codeRoutes ?? []).filter((r) => r.url.toLowerCase().startsWith(oldBase.toLowerCase())) : [];
	return (
		<Frame label="move">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void confirm();
				}}
			>
				<h2 id="dlg-h">Change {doc.label}’s address</h2>
				{intro ? <p>{intro}</p> : null}
				{nested ? (
					<div className="field">
						<label className="field-label" htmlFor="mv-inside">
							Inside
						</label>
						<InsidePicker id="mv-inside" options={options} value={inside} newGroup={NEW_GROUP} onChange={(v) => (setInside(v), setError(null))} />
					</div>
				) : null}
				{newGroup ? (
					<div className="field">
						<label className="field-label" htmlFor="mv-group">
							Group name
						</label>
						<input className="input" id="mv-group" value={group} placeholder="e.g. Studio" autoComplete="off" onChange={(e) => (setGroup(e.target.value), setError(null))} />
					</div>
				) : null}
				<div className="field">
					<label className="field-label" htmlFor="mv-part">
						The address's last part
					</label>
					<input
						className="input mono"
						id="mv-part"
						data-autofocus=""
						value={part}
						autoComplete="off"
						spellCheck={false}
						aria-invalid={shown ? true : undefined}
						aria-describedby={shown ? 'mv-err' : undefined}
						onChange={(e) => (setPart(e.target.value), setError(null))}
					/>
					<p className="urlpre" data-address={url ?? ''}>
						<Icon name="page" size="xs" />
						<span>
							{same ? 'Its address now: ' : 'Its new address: '}
							<span className="mono">
								{host}
								{base}
								<b>{last || '…'}</b>
							</span>
						</span>
					</p>
					<Err id="mv-err" text={shown} />
					{same ? null : (
						<p className="field-help" data-from={doc.url}>
							Now at <span className="mono">{`${host}${doc.url}`}</span>
						</p>
					)}
				</div>
				{many ? (
					<div className="field" data-moving={moving.length}>
						<p className="field-help">
							{withIt} {same ? 'The addresses now:' : 'The new addresses:'}
						</p>
						<ul className="mv-list" aria-label="Every address that changes" tabIndex={0}>
							{moving.map((m) => (
								<li key={`${m.doc.collection}/${m.doc.path}`} className="mono" data-to={m.toUrl ?? ''}>
									{same ? m.doc.url : (m.toUrl ?? '…')}
								</li>
							))}
						</ul>
						{routes.length ? (
							<p className="field-help" data-routes={routes.length}>
								<Icon name="warn" size="xs" /> {andList(routes.map((r) => r.file))} {routes.length === 1 ? 'is' : 'are'} the site’s own code under {doc.url}, so {routes.length === 1 ? 'it stays' : 'they stay'} where {routes.length === 1 ? 'it is' : 'they are'}.
							</p>
						) : null}
					</div>
				) : null}
				{choose ? (
					<div className="field">
						<label className="check">
							<input type="checkbox" id="mv-redirect" checked={redirect} aria-describedby="mv-redirect-h" onChange={(e) => setRedirect(e.target.checked)} />
							<span>
								{many ? (
									'Leave redirects from the old addresses'
								) : (
									<>
										Leave a redirect from <span className="mono">{doc.url}</span>
									</>
								)}
							</span>
						</label>
						<p className="field-help" id="mv-redirect-h">
							{many
								? redirect
									? `Anyone with an old address lands on the new one.${publish}`
									: 'Nothing will be at the old addresses: links to them from elsewhere will find no page.'
								: redirect
									? `Anyone with the old address lands here.${publish}`
									: `Nothing will be at ${doc.url}: links to it from elsewhere will find no page.`}
						</p>
					</div>
				) : null}
				<div className="acts">
					<button type="button" className="btn" onClick={() => closeDialog(editor)}>
						Cancel
					</button>
					<button type="submit" className="btn ink" data-act="confirm-move" disabled={blocked}>
						Change address
					</button>
				</div>
			</form>
		</Frame>
	);
}

// ── Rename… ──────────────────────────────────────────────────────────────────

/**
 * The open document's title: an ordinary edit (kept, and in live mode published, like
 * any other), so it goes through the document store. The address doesn't change:
 * that's Change address….
 */
function RenameDocument() {
	const editor = useEditor();
	const title = useStore(editor.doc.state, (s) => s.document.title);
	const current = useStore(editor.doc.state, (s) => s.document.title || s.entry.label);
	// Taken by someone else, signed out or deleted since the menu opened: setTitle would do nothing.
	const readOnly = useStore(editor.access, (a) => a.readOnly);
	const [name, setName] = useState(current);
	const next = name.replace(/\s+/g, ' ').trim();
	// Finding 15: a document with no title may take the name it's listed by as its title.
	const blocked = !next || next === title || readOnly;
	const confirm = () => {
		if (blocked) return;
		editor.doc.setTitle(next);
		editor.announce(`Renamed to ${next}`);
		closeDialog(editor);
	};
	return (
		<Frame label="rename">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					confirm();
				}}
			>
				<h2 id="dlg-h">Rename {current}</h2>
				<div className="field">
					<label className="field-label" htmlFor="rn-name">
						Name
					</label>
					<input className="input" id="rn-name" data-autofocus="" value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} />
					<p className="field-help">What the editor calls it. Its address stays as it is.</p>
				</div>
				<div className="acts">
					<button type="button" className="btn" onClick={() => closeDialog(editor)}>
						Cancel
					</button>
					<button type="submit" className="btn ink" data-act="confirm-rename" disabled={blocked}>
						Rename
					</button>
				</div>
			</form>
		</Frame>
	);
}

// ── + New shared block ───────────────────────────────────────────────────────

function NewShared() {
	const editor = useEditor();
	const documents = useStore(editor.documents);
	const types = Object.values(editor.site.blocks);
	const [type, setType] = useState<string | null>(null);
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const path = slugify(name);
	const local = !name.trim()
		? null
		: !path
			? NO_ADDRESS_MESSAGE
			: path === RESERVED_SLUG
				? INDEX_MESSAGE
				: documents.some((d) => d.collection === 'shared' && d.path === path)
					? `There's already a shared block called “${documents.find((d) => d.collection === 'shared' && d.path === path)!.label}”.`
					: null;
	const shown = error ?? local;
	const blocked = !type || !name.trim() || !!local || busy;
	const create = async () => {
		if (blocked) return;
		setBusy(true);
		setError(null);
		const answer = await createDocument(editor, { collection: 'shared', path, title: name.trim(), blockType: type! });
		setBusy(false);
		if (answer.ok) closeDialog(editor);
		else setError(answer.error);
	};
	return (
		<Frame label="new-shared">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void create();
				}}
			>
				<h2 id="dlg-h">New shared block</h2>
				<div className="field">
					<span className="field-label" id="ns-t">
						Block type
					</span>
					<div className="tgrid" role="radiogroup" aria-labelledby="ns-t" style={{ marginTop: 'var(--space-1-5)' }}>
						{types.map((t) => (
							<button key={t.type} type="button" className="ptype sm" role="radio" aria-checked={type === t.type} data-type={t.type} onClick={() => (setType(t.type), setError(null))}>
								<Icon name={blockIcon({ type: t.type, known: true })} />
								<b>{t.label}</b>
							</button>
						))}
					</div>
				</div>
				<div className="field">
					<label className="field-label" htmlFor="ns-name">
						Name
					</label>
					<input
						className="input"
						id="ns-name"
						value={name}
						placeholder="e.g. Client quote"
						autoComplete="off"
						aria-invalid={shown ? true : undefined}
						aria-describedby={shown ? 'ns-err' : undefined}
						onChange={(e) => (setName(e.target.value), setError(null))}
					/>
					<p className="field-help">Visitors don't see it.</p>
					<Err id="ns-err" text={shown} />
				</div>
				<div className="acts">
					<button type="button" className="btn" onClick={() => closeDialog(editor)}>
						Cancel
					</button>
					<button type="submit" className="btn ink" data-act="create-shared" disabled={blocked}>
						Create shared block
					</button>
				</div>
			</form>
		</Frame>
	);
}

// ── Discard changes ──────────────────────────────────────────────────────────

/**
 * Discard changes (live mode): asks first, naming anyone else whose changes go too, then puts
 * the document back to what's live (editor.discardChanges). The server's sentence when it
 * refuses (someone editing it now, a Publish running). Gone from the waiting list meanwhile:
 * it closes.
 */
function DiscardChanges({ file }: { file: string }) {
	const editor = useEditor();
	const item = useStore(editor.liveState, (s) => s.status?.waiting.find((w) => w.file === file) ?? null);
	const you = useStore(editor.liveState, (s) => s.status?.you ?? null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [seen] = useState(item);
	const shown = item ?? (busy ? seen : null);
	useEffect(() => {
		if (!shown) closeDialog(editor);
	}, [shown, editor]);
	if (!shown) return null;
	const collection = editor.site.collections.find((c) => c.name === shown.collection);
	const noun = collection?.kind === 'shared' ? 'shared block' : collection ? singular(collection) : 'page';
	const words = discardWording(shown, you ?? editor.you, noun);
	const confirm = async () => {
		setBusy(true);
		setError(null);
		const answer = await editor.discardChanges(shown);
		setBusy(false);
		if (answer.ok) closeDialog(editor);
		else setError(answer.error);
	};
	return (
		<Frame alert label="discard" describedBy="dlg-d">
			<div className="icon-h" style={{ background: 'var(--status-danger-wash)', color: 'var(--status-danger)' }}>
				<Icon name="undo" />
			</div>
			<h2 id="dlg-h">{words.heading}</h2>
			<p id="dlg-d">{words.body}</p>
			<Err id="discard-err" text={error} />
			<div className="acts">
				<button type="button" className="btn" onClick={() => closeDialog(editor)}>
					Cancel
				</button>
				<button type="button" className="btn danger" data-act="confirm-discard" disabled={busy} onClick={() => void confirm()}>
					{words.confirm}
				</button>
			</div>
		</Frame>
	);
}

// ── Delete ───────────────────────────────────────────────────────────────────

function DeleteDocument({ docRef }: { docRef: DocRef }) {
	const editor = useEditor();
	const documents = useStore(editor.documents);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const doc = documents.find((d) => d.collection === docRef.collection && d.path === docRef.path);
	const collection = editor.site.collections.find((c) => c.name === docRef.collection);
	if (!doc || !collection) return null;
	// Collections under pages (Decision 12): a page that holds a collection isn't deleted, and says so instead of asking.
	const held = doc.holds ? editor.site.collections.find((c) => c.name === doc.holds && c.heldBy === collection.name) : undefined;
	if (held) {
		return (
			<Frame alert label="holds" describedBy="dlg-d">
				<div className="icon-h" style={{ background: 'var(--status-warning-wash)', color: 'var(--status-warning)' }}>
					<Icon name="warn" />
				</div>
				<h2 id="dlg-h">{doc.label} can’t be deleted</h2>
				<p id="dlg-d">{holdsMessage(doc.label, held.label)}</p>
				<div className="acts">
					<button type="button" className="btn ink" data-act="holds-ok" onClick={() => closeDialog(editor)}>
						OK
					</button>
				</div>
			</Frame>
		);
	}
	const shared = collection.kind === 'shared';
	const kids = collection.nested ? pagesUnder(collection.name, doc.path, documents) : [];
	const host = editor.site.host;
	const url = doc.url ?? '';
	const confirm = async () => {
		setBusy(true);
		setError(null);
		const answer = await deleteDocument(editor, docRef, doc.label);
		setBusy(false);
		if (answer.ok) closeDialog(editor);
		else if (answer.code === 'in-use') openDialog(editor, { kind: 'in-use', ref: docRef, usedOn: answer.usedOn ?? undefined });
		else if (answer.code === 'default') openDialog(editor, { kind: 'is-default', ref: docRef });
		else setError(answer.error);
	};
	return (
		<Frame alert label="delete" describedBy="dlg-d">
			<div className="icon-h" style={{ background: 'var(--status-danger-wash)', color: 'var(--status-danger)' }}>
				<Icon name="trash" />
			</div>
			<h2 id="dlg-h">Delete {doc.label}?</h2>
			<p id="dlg-d">
				{shared ? (
					"It isn't on any page, so nothing on the site changes."
				) : collection.urlBase === null ? (
					// M6c (G1): no page of its own, so no address stops working; pages showing it drop it.
					editor.mode === 'live' ? (
						`${doc.label} disappears from the pages that show it at the next Publish.`
					) : (
						`${doc.label} is removed, and disappears from the pages that show it.`
					)
				) : editor.mode === 'live' ? (
					<>
						<span className="mono">{`${host}${url === '/' ? '' : url}`}</span> stops working at the next Publish.
					</>
				) : (
					<>
						{doc.label} is removed, and <span className="mono">{`${host}${url === '/' ? '' : url}`}</span> stops working.
					</>
				)}
			</p>
			{kids.length ? (
				<p data-kids={kids.length}>
					Its {kids.length} page{kids.length === 1 ? '' : 's'} stay{kids.length === 1 ? 's' : ''}, in a {doc.label} group: {andList(kids.map((k) => k.label))} keep
					{kids.length === 1 ? 's its address' : ' their addresses'}.
				</p>
			) : null}
			<Err id="del-err" text={error} />
			<div className="acts">
				<button type="button" className="btn" onClick={() => closeDialog(editor)}>
					Cancel
				</button>
				<button type="button" className="btn danger" data-act="confirm-delete" disabled={busy} onClick={() => void confirm()}>
					Delete {shared ? 'shared block' : singular(collection)}
				</button>
			</div>
		</Frame>
	);
}

/**
 * M6 Decision 9: deleting a submission is permanent (its files, then its message), so it
 * asks first. Done, the sheet closes and the list drops it.
 */
function DeleteSubmission({ id, who, files }: { id: string; who: string; files: number }) {
	const editor = useEditor();
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const confirm = async () => {
		setBusy(true);
		setError(null);
		const answer = await inboxFor(editor).remove(id);
		// The answer may come after this dialog was left and another message opened (delete one, then
		// straight on to the next): it closes only its own dialog and its own sheet.
		const mine = () => {
			const open = dialogOf(editor).get();
			return open?.kind === 'sub-delete' && open.id === id;
		};
		if (!answer.ok) {
			const error = answer.error ?? "It wasn't deleted. Try again in a moment.";
			if (mine()) {
				setBusy(false);
				setError(error);
			} else editor.toast(`${who}’s message wasn’t deleted. ${error}`, 'warn');
			return;
		}
		if (mine()) closeDialog(editor);
		if (editor.view.get().inbox?.id === id) editor.openInbox(null);
		editor.toast(`Deleted ${who}’s message${files ? ` and its ${filesLabel(files)}` : ''}`, 'trash');
	};
	return (
		<Frame alert label="sub-delete" describedBy="dlg-d">
			<div className="icon-h" style={{ background: 'var(--status-danger-wash)', color: 'var(--status-danger)' }}>
				<Icon name="trash" />
			</div>
			<h2 id="dlg-h">Delete {who}’s message?</h2>
			<p id="dlg-d">
				It’s deleted for good{files ? `, with its ${filesLabel(files)}` : ''}. There’s no undo.
			</p>
			<Err id="del-err" text={error} />
			<div className="acts">
				<button type="button" className="btn" onClick={() => closeDialog(editor)}>
					Cancel
				</button>
				<button type="button" className="btn danger" data-act="sub-delete-confirm" disabled={busy} onClick={() => void confirm()}>
					Delete for good
				</button>
			</div>
		</Frame>
	);
}

/** A shared block that pages still use can't be deleted (Decision 8): where it's used, each a way there. */
/** Arrange pages (Decision 15; the mockup's #leave): what's arranged isn't saved anywhere, so leaving asks first. */
function LeaveArrange({ go }: { go: () => void }) {
	const editor = useEditor();
	return (
		<Frame label="arrange-leave" returnTo={() => document.querySelector<HTMLElement>('[data-pane-level="arrange"] [data-act="cancel"]')}>
			<h2 id="dlg-h">Leave without applying?</h2>
			<p>What you’ve arranged isn’t saved anywhere: leave now and it’s gone. Nothing on the site has changed.</p>
			<div className="acts">
				<button type="button" className="btn" data-act="leave-stay" onClick={() => closeDialog(editor)}>
					Keep arranging
				</button>
				<button type="button" className="btn ink" data-act="leave-go" onClick={go}>
					Leave without applying
				</button>
			</div>
		</Frame>
	);
}

/** Edit in context, Decision 3: a slot block that pages pick shows a few of them and "N more". */
const IN_USE_FEW = 5;

function InUse({ docRef, usedOn }: { docRef: DocRef; usedOn?: CreateDeleteRefusal['usedOn'] }) {
	const editor = useEditor();
	const documents = useStore(editor.documents);
	const doc = documents.find((d) => d.collection === docRef.collection && d.path === docRef.path);
	const where: ListedDocument[] = (usedOn ?? doc?.usedOn ?? [])
		.map((u) => documents.find((d) => d.collection === u.collection && d.path === u.path))
		.filter((d): d is ListedDocument => !!d);
	const title = doc?.label ?? docRef.path;
	const n = where.length;
	const slot = doc?.slot;
	const shown = slot && n > IN_USE_FEW + 1 ? where.slice(0, IN_USE_FEW) : where;
	return (
		<Frame alert label="in-use" describedBy="dlg-d">
			<div className="icon-h" style={{ background: 'var(--status-warning-wash)', color: 'var(--status-warning)' }}>
				<Icon name="shared" />
			</div>
			<h2 id="dlg-h">{slot ? `${n} page${n === 1 ? '' : 's'} pick${n === 1 ? 's' : ''} ${title}` : `${title} is still on ${n} page${n === 1 ? '' : 's'}`}</h2>
			<p id="dlg-d">{slot ? `Pick another ${slot} on ${n === 1 ? 'it' : 'them'} first.` : 'Remove it from these pages first.'}</p>
			<div className="dlg-list">
				{shown.map((d) => (
					<button
						key={`${d.collection}/${d.path}`}
						type="button"
						className="drow"
						data-doc={`${d.collection}/${d.path}`}
						onClick={() => {
							closeDialog(editor);
							void editor.openDocument({ collection: d.collection, path: d.path });
						}}
					>
						<Icon name={docIcon(editor.site.collections.find((c) => c.name === d.collection))} />
						<span className="nm">{d.label}</span>
						<span className="meta">
							<span className="mono">{d.url}</span>
						</span>
						<Icon name="chev-r" size="sm" />
					</button>
				))}
				{shown.length < n ? (
					<p className="dlg-more" data-more={n - shown.length}>
						and {n - shown.length} more
					</p>
				) : null}
			</div>
			<div className="acts">
				<button type="button" className="btn ink" onClick={() => closeDialog(editor)}>
					OK
				</button>
			</div>
		</Frame>
	);
}

/** Edit in context, Decision 3: "Footer is the default footer, so it can't be deleted. Make another the default first." */
function IsDefault({ docRef }: { docRef: DocRef }) {
	const editor = useEditor();
	const documents = useStore(editor.documents);
	const doc = documents.find((d) => d.collection === docRef.collection && d.path === docRef.path);
	const title = doc?.label ?? docRef.path;
	const slot = doc?.slot ?? 'block';
	return (
		<Frame alert label="is-default" describedBy="dlg-d">
			<div className="icon-h" style={{ background: 'var(--status-warning-wash)', color: 'var(--status-warning)' }}>
				<Icon name="shared" />
			</div>
			<h2 id="dlg-h">{`${title} is the default ${slot}`}</h2>
			<p id="dlg-d">{`${title} is the default ${slot}, so it can't be deleted. Make another the default first.`}</p>
			<div className="acts">
				<button type="button" className="btn ink" onClick={() => closeDialog(editor)}>
					OK
				</button>
			</div>
		</Frame>
	);
}
