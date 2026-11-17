/**
 * A file's own level in the library (M6c G4, Decision 8; the mockup's #file): what it is,
 * its address (copyable: what a link stores, M6c →
 * Decision 3), every document that links to it (by schema, the listing's `usedIn`, each a
 * link to the document), and Replace… (media/ReplaceDialog.tsx, Decision 9). The stage shows the
 * file large with Open in a new tab (media/LibraryStage.tsx).
 *
 * Nothing is deleted from the library: Replace… moves every link to a new version, and
 * this file stays at its address.
 */
import { useState } from 'react';
import { openDialog } from '../../documents/dialogs.tsx';
import { fileAddress, fileTypeOf } from '../../../../files.ts';
import { useEditor, useStore } from '../../context.tsx';
import { FieldIcon } from '../../fields/parts.tsx';
import { when } from '../../live/format.ts';
import { fileSize, mediaFor } from '../../media/store.ts';
import { Icon } from '../../shell/Icons.tsx';
import { CurrentHead, DocumentsTab, GlobalNotes, LevelTab, RecentStrip, Trail } from '../parts.tsx';
import { timeZoneOf } from './MediaLevel.tsx';

export function FileLevel({ fileKey }: { fileKey: string }) {
	const editor = useEditor();
	const media = mediaFor(editor);
	const files = useStore(media.files, (l) => l.list);
	const documents = useStore(editor.documents);
	const [copied, setCopied] = useState(false);
	const back = () => editor.goUp();
	const file = files?.find((f) => f.key === fileKey) ?? null;
	const name = file?.name ?? fileKey.slice(fileKey.lastIndexOf('/') + 1);
	const head = (sub?: string) => (
		<Trail>
			<DocumentsTab />
			<LevelTab name="Media" kind="Files" count={files ? String(files.length) : undefined} onClick={back} />
			<CurrentHead back={{ label: 'Back to Media', onClick: back }} crumb="Media" title={name} sub={sub} />
		</Trail>
	);
	if (!file) {
		return (
			<>
				{head()}
				<div className="side-body">
					<GlobalNotes />
				</div>
				<RecentStrip />
			</>
		);
	}
	const type = fileTypeOf(file.key);
	const address = fileAddress(file.key);
	const size = fileSize(file.bytes);
	const zone = timeZoneOf(editor);
	const uses = file.usedIn;
	const iconOf = (collection: string) => (collection === 'settings' ? 'gear' : collection === 'shared' ? 'shared' : editor.site.collections.find((c) => c.name === collection)?.kind === 'fields' ? 'case' : 'page');
	const copy = () => {
		void navigator.clipboard?.writeText(address).then(
			() => {
				setCopied(true);
				editor.announce('Address copied');
				setTimeout(() => setCopied(false), 1600);
			},
			() => undefined,
		);
	};
	return (
		<>
			{head(`${file.type}${size ? ` · ${size}` : ''}`)}
			<div className="side-body" data-media-item={file.key} data-file-level="">
				<GlobalNotes />
				<dl className="kv" style={{ marginTop: 0 }}>
					<dt>Type</dt>
					<dd>
						{file.type}
						{type && ['doc', 'xls', 'ppt'].includes(type.ext) ? ` (the older .${type.ext} format)` : ''}
					</dd>
					{size ? (
						<>
							<dt>Size</dt>
							<dd>{size}</dd>
						</>
					) : null}
					<dt>Uploaded</dt>
					<dd>
						{file.uploadedAt ? when(file.uploadedAt, zone, new Date().toISOString()) : 'Not known'}
						{file.by && file.by !== 'setup' ? ` by ${file.by}` : ''}
					</dd>
					<dt>Address</dt>
					<dd className="addr">
						<span className="mono" data-file-address="">
							{address}
						</span>
						<button type="button" className="ib" aria-label={copied ? 'Copied' : 'Copy the address'} title={copied ? 'Copied' : 'Copy the address'} onClick={copy}>
							<Icon name={copied ? 'check' : 'copy'} size="xs" />
						</button>
					</dd>
					<dt>On the site</dt>
					<dd>{type?.opensInTab ? 'Opens in a new tab, or downloads: each link says which' : 'Downloads'}</dd>
				</dl>
				<div className="file-acts">
					<button type="button" className="btn sm" data-act="file-replace" onClick={() => openDialog(editor, { kind: 'replace', key: file.key })}>
						<FieldIcon name="swap" size="sm" />
						Replace…
					</button>
					<a className="btn sm ghost" href={address} target="_blank" rel="noopener">
						<Icon name="ext" size="sm" />
						Open
					</a>
				</div>
				<p className="sec-h" style={{ marginTop: 'var(--space-5)' }}>
					{uses.length ? `Linked from ${uses.length}` : 'Nothing links to it'}
				</p>
				{uses.length ? (
					<div className="uses">
						{uses.map((u) => (
							<button key={`${u.collection}/${u.path}`} type="button" className="drow" data-use={`${u.collection}/${u.path}`} onClick={() => void editor.openDocument({ collection: u.collection, path: u.path })}>
								<Icon name={iconOf(u.collection)} />
								<span className="nm">{documents.find((d) => d.collection === u.collection && d.path === u.path)?.label ?? u.title}</span>
								<span className="meta">
									{u.links} link{u.links === 1 ? '' : 's'}
								</span>
								<Icon name="chev-r" size="sm" />
							</button>
						))}
					</div>
				) : (
					<p className="field-help">Nothing links to it.</p>
				)}
			</div>
			<RecentStrip />
		</>
	);
}
