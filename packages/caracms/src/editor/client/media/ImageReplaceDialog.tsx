/**
 * Replace… on an image in the library, beside the file one (ReplaceDialog.tsx), in the editor's
 * `#modal-root` (documents/dialogs.tsx → `{ kind: 'replace', key }` with an image's key).
 *
 * 1. **Choose**: drop or choose the new picture (an image only: a file or a clip is refused).
 * 2. **Uploading**: its real progress (media/store.ts → `uploadImage`); nothing changes yet.
 * 3. **Ready**: the old picture → the new one, every document that uses it (the listing's
 *    `usedIn`), and **Reset focal points** (off: a small edit keeps each use's focal point; on:
 *    a different shot). Each use keeps its alt text.
 * 4. **Replace on N pages** (documents/actions.ts → `replaceFile`): the same rules as a file's
 *    (unsent edits first; in live mode it lands whole or nothing changes).
 * 5. **Done**: where it changed; the old picture stays in the library.
 *
 * **The same bytes as the old picture** (the upload answered with the old key): nothing to
 * replace, and it says so.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { closeDialog, Frame } from '../documents/dialogs.tsx';
import { replaceFile } from '../documents/actions.ts';
import { useDrop } from '../fields/MediaField.tsx';
import { rowDate, timeZoneOf } from '../pane/levels/MediaLevel.tsx';
import { Icon } from '../shell/Icons.tsx';
import type { KeepStatus } from '../state/keeper.ts';
import { createStore } from '../state/store.ts';
import type { FileUse, LibraryImage } from '../../types.ts';
import { fileSize, mediaFor } from './store.ts';

type Phase =
	| { at: 'choose' }
	| { at: 'uploading'; name: string; bytes: number; tag: string }
	| { at: 'ready'; to: LibraryImage; busy?: boolean; failed?: string; blocked?: string }
	| { at: 'same'; name: string }
	| { at: 'done'; to: LibraryImage; relinked: FileUse[] };

const places = (n: number) => `${n} place${n === 1 ? '' : 's'}`;
const docs = (n: number) => `${n} document${n === 1 ? '' : 's'}`;
const names = (list: readonly string[]) => (list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
const dims = (x: Pick<LibraryImage, 'w' | 'h'>) => (x.w && x.h ? `${x.w} × ${x.h}` : '');

let tags = 0;

function Thumb({ src, src2x }: { src: string | null; src2x?: string }) {
	return <span className="rthumb">{src ? <img src={src} srcSet={src2x ? `${src} 1x, ${src2x} 2x` : undefined} alt="" /> : null}</span>;
}

export function ImageReplaceDialog({ imageKey }: { imageKey: string }) {
	const editor = useEditor();
	const media = mediaFor(editor);
	const images = useStore(media.images, (l) => l.list);
	const uploads = useStore(media.uploads);
	const kept = useMemo(() => createStore<KeepStatus>({ state: 'kept', error: null }), []);
	const keep = useStore(editor.keeper?.status ?? kept, (k) => k.state);
	const [phase, setPhase] = useState<Phase>({ at: 'choose' });
	const [resetFocal, setResetFocal] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const old = images?.find((i) => i.key === imageKey) ?? null;
	const live = editor.mode === 'live';
	const zone = timeZoneOf(editor);

	useEffect(() => {
		if (phase.at === 'ready' && phase.blocked && keep === 'kept') setPhase({ ...phase, blocked: undefined });
	}, [keep, phase]);

	const take = async (file: File) => {
		setError(null);
		const tag = `replace-${++tags}`;
		setPhase({ at: 'uploading', name: file.name, bytes: file.size, tag });
		const sent = await media.uploadImage(file, tag);
		if (!sent.ok) {
			setPhase({ at: 'choose' });
			if (sent.error) setError(sent.error);
			return;
		}
		if (sent.image.key === imageKey) setPhase({ at: 'same', name: file.name });
		else setPhase({ at: 'ready', to: sent.image });
	};
	const drop = useDrop((list) => {
		if (list[0] && (phase.at === 'choose' || phase.at === 'same' || phase.at === 'ready')) void take(list[0]);
	});

	if (!old) return null;
	const uses = old.usedIn;

	const go = async () => {
		if (phase.at !== 'ready') return;
		setPhase({ ...phase, busy: true, failed: undefined });
		const answer = await replaceFile(editor, old.key, phase.to.key, { resetFocal });
		if (answer.ok) {
			void media.loadImages();
			setPhase({ at: 'done', to: phase.to, relinked: answer.body.relinked });
			const n = answer.body.relinked.reduce((k, r) => k + r.links, 0);
			editor.announce(n ? `${places(n)} now show ${phase.to.name}.` : `Nothing used ${old.name}.`);
		} else if (answer.code === 'unsent') setPhase({ ...phase, busy: false, blocked: answer.error });
		else setPhase({ ...phase, busy: false, failed: answer.error });
	};

	const oldRow = (
		<div className="frow old">
			<Thumb src={old.thumbnail} src2x={old.thumbnail2x} />
			<span className="ft">
				<b>{old.name}</b>
				<small>
					{dims(old) || 'Size not known'}
					{old.uploadedAt ? ` · ${rowDate(old.uploadedAt, zone)}` : ''} · used on {uses.length}
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
			accept="image/*,.heic,.heif"
			data-replace-file=""
			onChange={(e) => {
				const file = e.target.files?.[0];
				e.target.value = '';
				if (file) void take(file);
			}}
		/>
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
				<h2 id="dlg-h">{moved ? 'The new picture is in place' : 'Nothing used the old picture'}</h2>
				{moved ? (
					<p>
						{names(phase.relinked.map((r) => r.title))} {phase.relinked.length === 1 ? 'shows' : 'show'} <b style={{ color: 'var(--text)' }}>{phase.to.name}</b>.{' '}
						{live ? 'Live at the next Publish.' : 'The pages are saved with it.'}
					</p>
				) : null}
				{phase.relinked.length ? (
					<div className="affects" style={{ background: 'var(--surface)' }}>
						<ul style={{ margin: 0 }}>
							{phase.relinked.map((r) => (
								<li key={`${r.collection}/${r.path}`}>
									<Icon name="page" size="sm" />
									<span className="nm">{r.title}</span>
									<span className="meta">{places(r.links)}</span>
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
							editor.openMedia({ item: phase.to.key, tab: 'images' });
						}}
					>
						Open the new picture
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
					<b>Drop the new picture here</b>
					<span>or choose one</span>
					<span className="fine">JPEG, PNG, WebP, AVIF, HEIC, GIF or SVG, up to 40 MB</span>
				</button>
			</div>
		);
		if (error)
			note = (
				<div className="note danger" role="alert">
					<Icon name="warn" />
					<div>
						<b>That picture wasn’t taken</b>
						<p>{error}</p>
					</div>
				</div>
			);
	} else if (phase.at === 'uploading') {
		const up = uploads.find((u) => u.id === phase.tag);
		const pct = up?.pct ?? 0;
		middle = (
			<div className="swap">
				{oldRow}
				{arrow}
				<div className="frow new" role="status" aria-label={`${phase.name}, uploading, ${pct}%`}>
					<Thumb src={up?.preview ?? null} />
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
					<Thumb src={old.thumbnail} src2x={old.thumbnail2x} />
					<span className="ft">
						<b>{phase.name}</b>
						<small>the same picture</small>
					</span>
					{change}
				</div>
			</div>
		);
		note = (
			<div className="note" role="status" data-replace-same="">
				<Icon name="copy" />
				<div>
					<b>That’s the picture that’s already here</b>
					<p>Same contents as {old.name}. Choose the new version.</p>
				</div>
			</div>
		);
	} else {
		const total = uses.length;
		middle = (
			<>
				<div className="swap" {...drop.props}>
					{oldRow}
					{arrow}
					<div className="frow new">
						<Thumb src={phase.to.thumbnail} src2x={phase.to.thumbnail2x} />
						<span className="ft">
							<b>{phase.to.name}</b>
							<small>
								{dims(phase.to) ? `${dims(phase.to)} · ` : ''}
								<span className="new">Just uploaded</span>
							</small>
						</span>
						{phase.busy ? null : change}
					</div>
				</div>
				<div className="affects">
					<b>{total ? `Changes it on ${docs(total)}` : 'Nothing uses it yet'}</b>
					<p>{total ? `Each keeps its alt text. ${live ? 'Live at the next Publish.' : 'Each page is saved with the new picture.'}` : 'No page changes.'}</p>
					{uses.length ? (
						<ul>
							{uses.map((u) => (
								<li key={`${u.collection}/${u.path}`}>
									<Icon name="page" size="sm" />
									<span className="nm">{u.title}</span>
								</li>
							))}
						</ul>
					) : null}
				</div>
				{total ? (
					<div className="field" style={{ marginTop: 'var(--space-3)' }}>
						<label className="check">
							<input type="checkbox" id="rp-focal" checked={resetFocal} disabled={!!phase.busy} aria-describedby="rp-focal-h" data-replace-focal="" onChange={(e) => setResetFocal(e.target.checked)} />
							<span>Reset focal points</span>
						</label>
						<p className="field-help" id="rp-focal-h">
							For a different shot. Leave it off for a small edit to the same picture: each use keeps its own.
						</p>
					</div>
				) : null}
				<p className="keeps">
					<Icon name="clock" size="sm" />
					<span>The old picture stays in the library.</span>
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
				{phase.busy ? 'Replacing…' : phase.failed ? 'Try again' : total ? `Replace on ${docs(total)}` : 'Replace'}
			</button>
		);
	}

	return (
		<Frame label="replace">
			<h2 id="dlg-h">Replace {old.name}</h2>
			<p>Every page that uses it shows the new picture.</p>
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
