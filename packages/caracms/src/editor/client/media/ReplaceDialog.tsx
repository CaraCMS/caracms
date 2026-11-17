/**
 * Replace… on a file (M6c G4, Decision 9; the mockup's #replace, #replace-uploading,
 * #replace-ready, #replace-blocked, #replace-same, #replace-failed, #replace-done), in the
 * editor's `#modal-root` (documents/dialogs.tsx → `{ kind: 'replace', key }`).
 *
 * 1. **Choose**: drop or choose the new version, any type the library takes.
 * 2. **Uploading**: its real progress (media/store.ts → `uploadFile`); nothing changes yet.
 * 3. **Ready**: the old file → the new one, every document that will change (the
 *    listing's `usedIn`), that they become waiting changes (live mode), and that the old
 *    address keeps working.
 * 4. **Replace and update N links** (documents/actions.ts → `replaceFile`): refused while
 *    this tab holds unsent edits (it can start once they've gone through: the button wakes
 *    when the bar says Kept); in live mode a failure part way leaves every document as it
 *    was ("Nothing was changed", Try again).
 * 5. **Done**: where the links moved; the old file stays in the library, at its address.
 *
 * **The same bytes as the old file** (the upload answered with the old file's own key):
 * there's nothing to replace, and it says so. Bytes already in the library under another
 * name are fine: Replace uses that file (Decision 9), which is also how a retry after a
 * failed or cancelled Replace works, the new bytes having gone up first.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { closeDialog, Frame } from '../documents/dialogs.tsx';
import { replaceFile } from '../documents/actions.ts';
import { useDrop } from '../fields/MediaField.tsx';
import { FileTile, FILE_ACCEPT, rowDate, timeZoneOf } from '../pane/levels/MediaLevel.tsx';
import { Icon } from '../shell/Icons.tsx';
import type { KeepStatus } from '../state/keeper.ts';
import { createStore } from '../state/store.ts';
import type { FileUse, LibraryFile } from '../../types.ts';
import { fileSize, mediaFor } from './store.ts';

type Phase =
	| { at: 'choose' }
	| { at: 'uploading'; name: string; bytes: number; tag: string }
	| { at: 'ready'; to: LibraryFile; busy?: boolean; failed?: string; blocked?: string }
	| { at: 'same'; name: string; match: LibraryFile }
	| { at: 'done'; to: LibraryFile; relinked: FileUse[] };

const links = (n: number) => `${n} link${n === 1 ? '' : 's'}`;
const docs = (n: number) => `${n} document${n === 1 ? '' : 's'}`;
/** "Services", "Services and About", "Services, About and Contact". */
const names = (list: readonly string[]) => (list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

let tags = 0;

export function ReplaceDialog({ fileKey }: { fileKey: string }) {
	const editor = useEditor();
	const media = mediaFor(editor);
	const files = useStore(media.files, (l) => l.list);
	const uploads = useStore(media.uploads);
	const kept = useMemo(() => createStore<KeepStatus>({ state: 'kept', error: null }), []);
	const keep = useStore(editor.keeper?.status ?? kept, (k) => k.state);
	const [phase, setPhase] = useState<Phase>({ at: 'choose' });
	const [error, setError] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const old = files?.find((f) => f.key === fileKey) ?? null;
	const live = editor.mode === 'live';
	const zone = timeZoneOf(editor);

	// Blocked by unsent edits: the button wakes once the bar says Kept (the keeper retries on its own).
	useEffect(() => {
		if (phase.at === 'ready' && phase.blocked && keep === 'kept') setPhase({ ...phase, blocked: undefined });
	}, [keep, phase]);

	const take = async (file: File) => {
		setError(null);
		const tag = `replace-${++tags}`;
		setPhase({ at: 'uploading', name: file.name, bytes: file.size, tag });
		const sent = await media.uploadFile(file, tag);
		if (!sent.ok) {
			setPhase({ at: 'choose' });
			if (sent.error) setError(sent.error);
			return;
		}
		// The same bytes are the same key: the old file itself, so nothing to replace. A different file already in
		// the library (`created: false`, e.g. the new bytes from an earlier try) is used as it is.
		if (sent.file.key === fileKey) setPhase({ at: 'same', name: file.name, match: sent.file });
		else setPhase({ at: 'ready', to: sent.file });
	};
	const drop = useDrop((list) => {
		if (list[0] && (phase.at === 'choose' || phase.at === 'same' || phase.at === 'ready')) void take(list[0]);
	});

	if (!old) return null;
	const uses = old.usedIn;
	const total = uses.reduce((n, u) => n + u.links, 0);

	const go = async () => {
		if (phase.at !== 'ready') return;
		setPhase({ ...phase, busy: true, failed: undefined });
		const answer = await replaceFile(editor, old.key, phase.to.key);
		if (answer.ok) {
			void media.loadImages();
			setPhase({ at: 'done', to: phase.to, relinked: answer.body.relinked });
			const n = answer.body.relinked.reduce((k, r) => k + r.links, 0);
			editor.announce(n ? `${links(n)} now point at ${phase.to.name}.` : `Nothing linked to ${old.name}.`);
		} else if (answer.code === 'unsent') setPhase({ ...phase, busy: false, blocked: answer.error });
		else setPhase({ ...phase, busy: false, failed: answer.error });
	};

	const oldRow = (
		<div className="frow old">
			<FileTile />
			<span className="ft">
				<b>{old.name}</b>
				<small>
					<span className="ty">{old.type}</span>
					{old.bytes !== null ? ` · ${fileSize(old.bytes)}` : ''}
					{old.uploadedAt ? ` · ${rowDate(old.uploadedAt, zone)}` : ''} · linked from {uses.length}
				</small>
			</span>
		</div>
	);
	const arrow = (
		<div className="arrow">
			<Icon name="down" size="xs" />
			replaced by
		</div>
	);
	const change = (
		<button type="button" className="btn sm ghost" onClick={() => input.current?.click()}>
			Change…
		</button>
	);
	const picker = (
		<input
			ref={input}
			type="file"
			hidden
			accept={FILE_ACCEPT}
			data-replace-file=""
			onChange={(e) => {
				const file = e.target.files?.[0];
				e.target.value = '';
				if (file) void take(file);
			}}
		/>
	);
	const head = (
		<>
			<h2 id="dlg-h">Replace {old.name}</h2>
			<p>Every link moves to the new version.</p>
		</>
	);
	const cancel = (
		<button type="button" className="btn" onClick={() => closeDialog(editor)}>
			Cancel
		</button>
	);

	if (phase.at === 'done') {
		const moved = phase.relinked.reduce((n, r) => n + r.links, 0);
		return (
			<Frame label="replace-done">
				<div className="icon-h live">
					<Icon name="check" />
				</div>
				<h2 id="dlg-h">{moved ? 'The links now point at the new file' : 'Nothing linked to the old file'}</h2>
				{moved ? (
					<p>
						{links(moved)} in {names(phase.relinked.map((r) => r.title))} point at <b style={{ color: 'var(--text)' }}>{phase.to.name}</b>.{' '}
						{live ? 'Live at the next Publish.' : 'The pages are saved with the new address.'}
					</p>
				) : null}
				{phase.relinked.length ? (
					<div className="affects" style={{ background: 'var(--surface)' }}>
						<ul style={{ margin: 0 }}>
							{phase.relinked.map((r) => (
								<li key={`${r.collection}/${r.path}`}>
									<Icon name="page" size="sm" />
									<span className="nm">{r.title}</span>
									<span className="meta">{links(r.links)}</span>
									{live ? <span className="dot" title="Changes waiting" /> : null}
								</li>
							))}
						</ul>
					</div>
				) : null}
				<div className="acts">
					<button
						type="button"
						className="btn"
						onClick={() => {
							closeDialog(editor);
							editor.openMedia({ item: phase.to.key, tab: 'files' });
						}}
					>
						Open the new file
					</button>
					<button type="button" className="btn ink" data-autofocus="" onClick={() => closeDialog(editor)}>
						Done
					</button>
				</div>
			</Frame>
		);
	}

	let middle;
	let note = null;
	let action = (
		<button type="button" className="btn ink" disabled>
			Replace
		</button>
	);
	if (phase.at === 'choose') {
		middle = (
			<div className="swap">
				{oldRow}
				{arrow}
				<button type="button" className={`mdrop${drop.over ? ' is-over' : ''}`} data-replace-drop="" onClick={() => input.current?.click()} {...drop.props}>
					<Icon name="upload" />
					<b>Drop the new version here</b>
					<span>or choose a file</span>
					<span className="fine">PDF, Word, Excel, PowerPoint, CSV or Zip, up to 40 MB</span>
				</button>
			</div>
		);
		if (error)
			note = (
				<div className="note danger" role="alert">
					<Icon name="warn" />
					<div>
						<b>That file wasn’t taken</b>
						<p>{error}</p>
					</div>
				</div>
			);
	} else if (phase.at === 'uploading') {
		const pct = uploads.find((u) => u.id === phase.tag)?.pct ?? 0;
		middle = (
			<div className="swap">
				{oldRow}
				{arrow}
				<div className="frow new" role="status" aria-label={`${phase.name}, uploading, ${pct}%`}>
					<FileTile />
					<span className="ft">
						<b>{phase.name}</b>
						<small>
							{fileSize(phase.bytes)} · {pct ? `Uploading · ${pct}%` : 'Waiting…'}
						</small>
						<span className="mbar">
							<i style={{ ['--p' as string]: `${pct}%` }} />
						</span>
					</span>
				</div>
			</div>
		);
	} else if (phase.at === 'same') {
		middle = (
			<div className="swap" {...drop.props}>
				{oldRow}
				{arrow}
				<div className="frow new">
					<FileTile />
					<span className="ft">
						<b>{phase.name}</b>
						<small>
							<span className="ty">{phase.match.type}</span>
							{phase.match.bytes !== null ? ` · ${fileSize(phase.match.bytes)}` : ''} · the same file
						</small>
					</span>
					{change}
				</div>
			</div>
		);
		note = (
			<div className="note" role="status" data-replace-same="">
				<Icon name="copy" />
				<div>
					<b>That’s the file that’s already here</b>
					<p>Same contents as {old.name}. Choose the new version.</p>
				</div>
			</div>
		);
	} else {
		middle = (
			<>
				<div className="swap" {...drop.props}>
					{oldRow}
					{arrow}
					<div className="frow new">
						<FileTile />
						<span className="ft">
							<b>{phase.to.name}</b>
							<small>
								<span className="ty">{phase.to.type}</span>
								{phase.to.bytes !== null ? ` · ${fileSize(phase.to.bytes)}` : ''} · <span className="new">Just uploaded</span>
							</small>
						</span>
						{phase.busy ? null : change}
					</div>
				</div>
				<div className="affects">
					<b>{total ? `Updates ${links(total)} in ${docs(uses.length)}` : 'Nothing links to it yet'}</b>
					<p>{total ? (live ? 'Live at the next Publish.' : 'Each page is saved with the new address.') : 'No page changes.'}</p>
					{uses.length ? (
						<ul>
							{uses.map((u) => (
								<li key={`${u.collection}/${u.path}`}>
									<Icon name="page" size="sm" />
									<span className="nm">{u.title}</span>
									<span className="meta">{links(u.links)}</span>
								</li>
							))}
						</ul>
					) : null}
				</div>
				<p className="keeps">
					<Icon name="clock" size="sm" />
					<span>The old address keeps working.</span>
				</p>
			</>
		);
		if (phase.blocked)
			note = (
				<div className="note warn" role="alert" data-replace-blocked="">
					<Icon name="warn" />
					<div>
						<b>{phase.blocked}</b>
						<p>It starts once they have.</p>
					</div>
				</div>
			);
		else if (phase.failed)
			note = (
				<div className="note danger" role="alert" data-replace-failed="">
					<Icon name="warn" />
					<div>
						<b>Nothing was changed</b>
						<p>{phase.failed} Try again.</p>
					</div>
				</div>
			);
		action = (
			<button type="button" className="btn ink" data-act="replace-go" disabled={!!phase.busy || !!phase.blocked} onClick={() => void go()}>
				{phase.busy ? 'Replacing…' : phase.failed ? 'Try again' : total ? `Replace and update ${links(total)}` : 'Replace'}
			</button>
		);
	}

	return (
		<Frame label="replace">
			{head}
			{middle}
			{note}
			{picker}
			<div className="acts">
				{cancel}
				{action}
			</div>
		</Frame>
	);
}
