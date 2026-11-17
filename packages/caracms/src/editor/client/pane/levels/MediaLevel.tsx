/**
 * The library level (M5b Phase 3, Decision 7; the mockup's #library, #library-clips,
 * #library-upload, #library-image, #library-unused, #library-empty, #library-pick,
 * #library-pick-images, #library-picked-alt): `view.level === 'media'`.
 *
 * - **Browse** (Site-wide → Media): images and clips, newest first; Upload… and drops on
 *   the level or on the stage (shell/Stage.tsx dims the last page and makes it the big
 *   drop target); several files at once, each with real progress; a refused file says
 *   why, in red, until the library is left or a slot's picker opens. A tile opens its own
 *   level: the picture large on the stage, its facts, Replace… (media/ImageReplaceDialog.tsx:
 *   every use takes a new picture), where it's used (each a link to the document) and the alt
 *   text already used for it.
 * - **Pick** (a slot's Choose… or Replace…, `view.media.pick`): in place of the block's
 *   fields, the page left on the stage with the slot ringed (overlays/editor-marks.ts);
 *   one click places it (Decision 3's value through `pickMedia`, store.ts → place) and
 *   goes back to the field. A list's Add image takes several: each click adds a row in
 *   the order picked, and Done goes back, to the first row picked with no alt text (each
 *   is asked for in turn). A clip can be picked only once it can play.
 * - **Show unused** (on by default, remembered per browser) shows or hides what no
 *   document uses; what was uploaded in this tab always shows. **Nothing is ever deleted.**
 * - Last-known data while a refetch runs; no skeletons.
 * - **M6c G4: Files** (the mockup's #library-files, #library-unused, #file, #link-pick): a
 *   tab beside Images and Clips, each file a row (its type tile, name, type · size · date
 *   · how many places link to it); a file's own level gives its address (copyable), every
 *   document that links to it, and Replace… (FileLevel). A link field's or a button's
 *   File… opens the library on Files only (`pick.link`), and one click writes the file's
 *   address into the link.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useEditor, useStore } from '../../context.tsx';
import type { MediaPick, MediaView } from '../../editor.ts';
import { altAskFor, extOf, fmtDur, UploadCard, useDrop } from '../../fields/MediaField.tsx';
import { when } from '../../live/format.ts';
import { clipId, clipStill, fileSize, mediaFor, type MediaUpload } from '../../media/store.ts';
import { Icon } from '../../shell/Icons.tsx';
import type { LibraryClip, LibraryFile, LibraryImage } from '../../../types.ts';
import { getAtPath } from '../../../../fields.ts';
import { fileAddress, fileKeyOf, isFileKey } from '../../../../files.ts';
import { parseMedia } from '../../../../media-value.ts';
import { FileLevel } from './FileLevel.tsx';
import { openDialog } from '../../documents/dialogs.tsx';
import { FieldIcon } from '../../fields/parts.tsx';
import { CurrentHead, DocumentsTab, GlobalNotes, LevelTab, RecentStrip, Trail } from '../parts.tsx';
import { CollectionTab } from './FormLevel.tsx';

/** M6c G4: the files the library takes, by extension (the server reads the bytes). */
export const FILE_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.zip';
const ACCEPT = `image/*,video/*,.heic,.heif,${FILE_ACCEPT}`;

/** A hidden file input and the button that opens it (the browser's own file dialog). `filesOnly`: a link's picker. */
export function UploadButton({ className = 'btn sm', children, filesOnly = false }: { className?: string; children?: ReactNode; filesOnly?: boolean }) {
	const editor = useEditor();
	const media = mediaFor(editor);
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<button type="button" className={className} data-act="lib-upload" onClick={() => input.current?.click()}>
				<Icon name="upload" size="sm" />
				{children ?? 'Upload…'}
			</button>
			<input
				ref={input}
				type="file"
				multiple
				hidden
				accept={filesOnly ? FILE_ACCEPT : ACCEPT}
				data-lib-file=""
				onChange={(e) => {
					const files = [...(e.target.files ?? [])];
					e.target.value = '';
					if (files.length) media.upload(files);
				}}
			/>
		</>
	);
}

export function MediaLevel() {
	const editor = useEditor();
	const view = useStore(editor.view, (v) => v.media ?? null);
	const media = mediaFor(editor);
	// Made before the picker places anything: a gallery with no row open has no slot on screen to make it.
	altAskFor(editor);
	// Read again each time the library opens (the server keeps its listing 60 s); the last list shows meanwhile.
	useEffect(() => {
		void media.loadImages();
		void media.loadClips();
	}, [media]);
	const state: MediaView = view ?? { pick: null, item: null, tab: 'images' };
	if (state.item && isFileKey(state.item)) return <FileLevel fileKey={state.item} />;
	if (state.item) return <ItemLevel view={state} />;
	return <LibraryLevel view={state} />;
}

export const timeZoneOf = (editor: ReturnType<typeof useEditor>) => editor.liveState.get().status?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

function LibraryLevel({ view }: { view: MediaView }) {
	const editor = useEditor();
	const media = mediaFor(editor);
	const images = useStore(media.images);
	const clips = useStore(media.clips);
	const files = useStore(media.files);
	const uploads = useStore(media.uploads);
	const refused = useStore(media.refused);
	const unused = useStore(media.showUnused);
	const fresh = useStore(media.fresh);
	const session = useStore(editor.doc.state);
	const pick = view.pick;
	const only = pick?.only;
	const linking = !!pick?.link;
	// A slot never lists files (Decision 4); a link lists nothing else (Decision 7).
	const tab = linking ? 'files' : only === 'image' ? 'images' : only === 'video' ? 'clips' : pick && view.tab === 'files' ? 'images' : view.tab;
	const drop = useDrop((files) => media.upload(files));
	// A list's Add image: what this picker has added so far (the rows from the pick's first index on).
	const added = useRef<string[]>([]);
	useEffect(() => {
		added.current = [];
	}, [pick?.scope, pick?.multi]);

	const imgList = images.list ?? [];
	const clipList = clips.list ?? [];
	const fileList = files.list ?? [];
	const total = imgList.length + clipList.length + fileList.length;
	const atPick = pick ? getAtPath(editor.doc.block(pick.scope)?.data, pick.path) : null;
	const current = pick && !linking ? parseMedia(atPick) : null;
	const currentFile = linking ? (fileKeyOf(typeof atPick === 'string' ? atPick.trim() : null)?.key ?? null) : null;

	const setTab = (next: MediaView['tab']) => editor.view.update({ media: { ...view, tab: next } });
	const back = () => editor.goUp();

	// The picker's trail is the slot's own, one level deeper (the mockup's pickTrail): a block's slot under its page's
	// Blocks, a form's under its collection, Site Settings' brand slots under Editor branding.
	const kind = session.document.kind;
	const blocks = session.document.blocks.length;
	const head = pick ? (
		<Trail>
			<DocumentsTab />
			{kind === 'sections' ? (
				<LevelTab name={session.document.title || session.entry.label} kind="Blocks" count={`${blocks} block${blocks === 1 ? '' : 's'}`} onClick={() => editor.goTo('document')} />
			) : kind === 'fields' || kind === 'shared' ? (
				<CollectionTab name={session.ref.collection} />
			) : null}
			{kind === 'settings' ? <LevelTab name="Site Settings" kind="Editor branding" onClick={back} /> : <LevelTab name={pick.owner} kind="Fields" onClick={back} />}
			<CurrentHead
				back={{ label: `Back to ${pick.owner}`, onClick: back }}
				crumb={pick.owner}
				title={linking ? 'Choose a file' : only === 'image' ? 'Choose an image' : only === 'video' ? 'Choose a clip' : 'Choose an image or a clip'}
				sub={pick.label}
				menu={<UploadButton filesOnly={linking} />}
			/>
		</Trail>
	) : (
		<Trail>
			<DocumentsTab />
			<CurrentHead
				back={{ label: 'Back to documents', onClick: () => editor.goTo('documents') }}
				title="Media"
				chips={images.list || clips.list ? <span className="n-chip">{total}</span> : null}
				sub="Images, clips and files, for every page"
				menu={<UploadButton />}
			/>
		</Trail>
	);

	const place = (entry: LibraryImage | LibraryClip) => {
		if (!pick) return;
		const id = 'key' in entry ? entry.key : clipId(entry);
		if (pick.multi && added.current.includes(id)) return;
		if (!media.place(pick, entry)) return;
		if (pick.multi) {
			added.current = [...added.current, id];
			const top = pick.path.slice(0, pick.path.lastIndexOf('.'));
			const next = Number(pick.path.slice(pick.path.lastIndexOf('.') + 1)) + 1;
			const nextPick: MediaPick = { ...pick, path: `${top}.${next}`, label: pick.label.replace(/\d+$/, String(next + 1)) };
			editor.view.update({ media: { ...view, pick: nextPick } });
			return;
		}
		editor.view.update({ level: pick.back, media: null, field: pick.path, picked: false });
	};
	const done = () => {
		if (!pick) return;
		const top = pick.path.slice(0, pick.path.lastIndexOf('.'));
		// The first image picked with no alt text opens its row, asking for it (the rest are asked in turn: MediaField.tsx).
		const ask = altAskFor(editor).get();
		const first = ask && ask.scope === pick.scope && ask.path.startsWith(`${top}.`) ? ask.path : null;
		editor.view.update({ level: pick.back, media: null, field: first ?? (top || pick.path), picked: false });
	};

	const placeFile = (file: LibraryFile) => {
		if (!pick || editor.access.get().readOnly) return;
		editor.doc.setField(pick.scope, pick.path, fileAddress(file.key));
		editor.announce(`${file.name} is in the link`);
		editor.view.update({ level: pick.back, media: null, field: pick.path.split('.')[0]!, picked: false });
	};

	const unset = tab === 'clips' ? clips.unset : images.unset;
	let body: ReactNode;
	if (images.unset && (tab !== 'clips' || !pick)) {
		body = <UnsetNote sentence={images.unset.error} />;
	} else {
		const ups = uploads.filter((u) => !u.slot && (tab === 'clips' ? u.kind === 'clip' : tab === 'files' ? u.kind === 'file' : u.kind === 'image'));
		const empty = images.list !== null && clips.list !== null && total === 0 && uploads.length === 0;
		const used = (x: { usedIn: unknown[] }) => x.usedIn.length > 0;
		const list: (LibraryImage | LibraryClip | LibraryFile)[] = tab === 'images' ? imgList : tab === 'files' ? fileList : clipList;
		const idOf = (x: LibraryImage | LibraryClip | LibraryFile) => ('key' in x ? x.key : clipId(x));
		// A link's picker lists every file: picking one is how it becomes used.
		const shown = list.filter((x) => unused || linking || used(x) || fresh.has(idOf(x)) || ('ready' in x && !x.ready));
		const hidden = list.length - shown.length;
		const tabs = linking ? (
			<span className="only">
				Files <span className="n">· {fileList.length}</span>
			</span>
		) : only ? (
			<span className="only">
				{only === 'image' ? 'Images' : 'Clips'} <span className="n">· {only === 'image' ? imgList.length : clipList.length}</span>
			</span>
		) : (
			<div className="mini-seg" role="radiogroup" aria-label="Show">
				<button type="button" role="radio" aria-checked={tab === 'images'} data-v="images" onClick={() => setTab('images')}>
					Images <span className="n">{images.list ? imgList.length : ''}</span>
				</button>
				<button type="button" role="radio" aria-checked={tab === 'clips'} data-v="clips" onClick={() => setTab('clips')}>
					Clips <span className="n">{clips.list ? clipList.length : ''}</span>
				</button>
				{pick ? null : (
					<button type="button" role="radio" aria-checked={tab === 'files'} data-v="files" onClick={() => setTab('files')}>
						Files <span className="n">{files.list ? fileList.length : ''}</span>
					</button>
				)}
			</div>
		);
		body = (
			<>
				{refused.length ? (
					<div className="refused" role="alert">
						{refused.map((r) => (
							<div key={r.id} className="note danger has-x">
								<Icon name="warn" />
								<div>
									<b>{r.name}</b>
									<p>{r.message}</p>
								</div>
								<button type="button" className="ib" aria-label="Dismiss" onClick={() => media.dismissRefused(r.id)}>
									<Icon name="x" size="sm" />
								</button>
							</div>
						))}
					</div>
				) : null}
				{empty ? (
					<div className="empty" style={{ padding: 'var(--space-4)' }} data-library-empty="">
						<b>Nothing in the library yet</b>
						<span>Upload or drop images, clips or files.</span>
						<UploadButton className="btn ink" filesOnly={linking}>
							Upload…
						</UploadButton>
					</div>
				) : (
					<>
						<div className="lib-bar">
							{tabs}
							{linking ? null : (
								<button type="button" className="switch sm" role="switch" aria-checked={unused} data-act="lib-unused" onClick={() => media.setShowUnused(!unused)}>
									<span className="track" />
									<span>
										Show unused{hidden ? <span className="n"> · {hidden} hidden</span> : null}
									</span>
								</button>
							)}
						</div>
						{unset ? (
							<UnsetNote sentence={unset.error} />
						) : tab === 'files' && (shown.length || ups.length) ? (
							<div className="flist" data-flist="">
								{ups.map((u) => (
									<FileUploadRow key={u.id} upload={u} />
								))}
								{(shown as LibraryFile[]).map((x) => (
									<FileRow
										key={x.key}
										file={x}
										current={currentFile === x.key}
										fresh={fresh.has(x.key)}
										onClick={() => (linking ? placeFile(x) : editor.openMedia({ item: x.key, tab: 'files' }))}
									/>
								))}
							</div>
						) : tab === 'files' ? (
							files.list ? (
								<p className="no-hits">
									{fileList.length ? (
										<>
											<b>No files linked from anywhere yet</b>
											Turn on Show unused to see every file in the library.
										</>
									) : (
										<>
											<b>No files yet</b>
											Upload or drop a file.
										</>
									)}
								</p>
							) : null
						) : shown.length || ups.length ? (
							<div className={`lgrid${tab === 'clips' ? ' clips' : ''}`} data-lgrid={tab}>
								{ups.map((u) => (u.phase === 'failed' ? <FailedTile key={u.id} upload={u} /> : <UploadTile key={u.id} upload={u} />))}
								{(shown as (LibraryImage | LibraryClip)[]).map((x) =>
									'key' in x ? (
										<ImageTile
											key={x.key}
											image={x}
											pick={!!pick}
											current={(!!current && 'key' in current && current.key === x.key) || (!!pick?.multi && added.current.includes(x.key))}
											fresh={fresh.has(x.key)}
											onClick={() => (pick ? place(x) : editor.openMedia({ item: x.key, tab: 'images' }))}
										/>
									) : (
										<ClipTile
											key={x.id}
											clip={x}
											pick={!!pick}
											current={(!!current && 'video' in current && current.video === x.playbackId) || (!!pick?.multi && added.current.includes(clipId(x)))}
											fresh={fresh.has(clipId(x))}
											onClick={() => (pick ? place(x) : editor.openMedia({ item: clipId(x), tab: 'clips' }))}
										/>
									),
								)}
							</div>
						) : list.length || (tab === 'images' ? images.list : clips.list) ? (
							<p className="no-hits">
								<b>{tab === 'images' ? 'No images' : 'No clips'} in use yet</b>
								Turn on Show unused to see everything in the library.
							</p>
						) : null}
					</>
				)}
				{pick?.multi ? (
					<div className="lib-done" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
						<button type="button" className="btn ink" data-act="pick-done" onClick={done}>
							Done
						</button>
						<span className="kb-hint" style={{ margin: 0 }}>
							Each one you click is added to the {pick.owner.toLowerCase()}, in order.
						</span>
					</div>
				) : null}
			</>
		);
	}

	return (
		<>
			{head}
			<div className={`side-body${drop.over ? ' is-over' : ''}`} data-drop-lib="" data-media-mode={pick ? 'pick' : 'browse'} {...drop.props}>
				<GlobalNotes />
				{body}
			</div>
			<RecentStrip />
		</>
	);
}

export function UnsetNote({ sentence }: { sentence: string }) {
	return (
		<div className="note tight" data-media-unset="">
			<Icon name="media" />
			<div>
				<b>Media isn't set up on this server yet</b>
				<p>{sentence}</p>
			</div>
		</div>
	);
}

/** "14 Oct" this year, "4 Mar 2025" before, in the site's time zone. */
export function rowDate(iso: string | null, zone: string): string {
	if (!iso) return '';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '';
	const year = (d: Date) => new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: zone }).format(d);
	const sameYear = year(date) === year(new Date());
	return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: zone }).format(date);
}

/** The type tile: a page with its corner folded (neutral for every type); the large one carries the label. */
export function FileTile({ type, size }: { type?: string; size?: 'sm' | 'lg' }) {
	return (
		<span className={`ftype${size ? ` ${size}` : ''}`} aria-hidden="true">
			{size === 'lg' ? type : null}
		</span>
	);
}

/** A file's row in the library (the mockup's .frow): the tile, the name, then type · size · date · use. */
export function FileRow(props: { file: LibraryFile; current: boolean; fresh: boolean; onClick: () => void }) {
	const editor = useEditor();
	const { file: x, current } = props;
	const n = x.usedIn.length;
	const use = current ? 'In this link' : props.fresh ? null : n ? `Linked from ${n}` : 'Unused';
	return (
		<button type="button" className={`frow${current ? ' is-current' : ''}`} data-file={x.key} title={`${x.name} · ${x.type}`} aria-current={current ? 'true' : undefined} onClick={props.onClick}>
			<FileTile />
			<span className="ft">
				<b>{x.name}</b>
				<small>
					<span className="ty">{x.type}</span>
					{x.bytes !== null ? ` · ${fileSize(x.bytes)}` : ''}
					{x.uploadedAt ? ` · ${rowDate(x.uploadedAt, timeZoneOf(editor))}` : ''} · {use ?? <span className="new">Just uploaded</span>}
				</small>
			</span>
			{current ? (
				<span className="pcheck">
					<Icon name="check" size="xs" />
				</span>
			) : null}
		</button>
	);
}

/** A file on its way up: real progress, the row's shape kept. */
export function FileUploadRow({ upload: u, className = '' }: { upload: MediaUpload; className?: string }) {
	return (
		<div className={`frow${className ? ` ${className}` : ''}`} role="status" aria-label={`${u.name}, uploading, ${u.pct}%`} data-upload={u.id}>
			<FileTile />
			<span className="ft">
				<b>{u.name}</b>
				<small>
					{fileSize(u.bytes)} · {u.pct ? `Uploading · ${u.pct}%` : 'Waiting…'}
				</small>
				<span className="mbar">
					<i style={{ ['--p' as string]: `${u.pct}%` }} />
				</span>
			</span>
		</div>
	);
}

function ImageTile(props: { image: LibraryImage; pick: boolean; current: boolean; fresh: boolean; onClick: () => void }) {
	const { image: x, current } = props;
	const n = x.usedIn.length;
	return (
		<button
			type="button"
			className={`mtile${current ? ' is-current' : ''}`}
			data-key={x.key}
			title={`${x.name}${x.w && x.h ? ` · ${x.w} × ${x.h}` : ''}`}
			aria-current={current ? 'true' : undefined}
			onClick={props.onClick}
		>
			<span className="ph">
				<img className="ph-img" src={x.thumbnail} srcSet={`${x.thumbnail} 1x, ${x.thumbnail2x} 2x`} alt="" loading="lazy" />
			</span>
			{current ? (
				<span className="pcheck">
					<Icon name="check" size="xs" />
				</span>
			) : null}
			<span className="nm">{x.name}</span>
			{props.fresh ? <span className="mt new">Just added</span> : <span className="mt">{current && props.pick ? 'In this slot' : n ? `Used on ${n}` : 'Unused'}</span>}
		</button>
	);
}

function ClipTile(props: { clip: LibraryClip; pick: boolean; current: boolean; fresh: boolean; onClick: () => void }) {
	const { clip: c, current } = props;
	const title = c.title ?? 'A clip';
	if (c.errored) {
		return (
			<div className="mfail" role="group" aria-label={`${title}, failed`} data-clip={c.id}>
				<span className="ph pending">
					<Icon name="warn" />
				</span>
				<div>
					<b>{title}</b>
					<p>{c.error}</p>
				</div>
			</div>
		);
	}
	const proc = !c.ready;
	const n = c.usedIn.length;
	const meta = proc ? 'Processing: under a minute' : props.fresh ? 'Just added' : current && props.pick ? 'In this slot' : n ? `Used on ${n}` : 'Unused';
	return (
		<button
			type="button"
			className={`mtile${current ? ' is-current' : ''}`}
			data-clip={c.id}
			disabled={proc}
			title={proc ? (props.pick ? "It can be chosen once it's ready to play" : 'Mux is getting it ready to play') : `${title} · ${fmtDur(c.duration)}`}
			aria-current={current ? 'true' : undefined}
			onClick={props.onClick}
		>
			{proc ? (
				<span className="ph pending">
					<Icon name="film" />
					<span className="mbar busy">
						<i />
					</span>
				</span>
			) : (
				<span className="ph">
					{c.playbackId ? <img className="ph-img" src={clipStill(c.playbackId, 0)} alt="" loading="lazy" /> : null}
					<span className="pbadge">{fmtDur(c.duration)}</span>
				</span>
			)}
			{current ? (
				<span className="pcheck">
					<Icon name="check" size="xs" />
				</span>
			) : null}
			<span className="nm">{title}</span>
			<span className={`mt${props.fresh && !proc ? ' new' : ''}`}>{meta}</span>
		</button>
	);
}

function UploadTile({ upload: u }: { upload: MediaUpload }) {
	const proc = u.phase === 'proc';
	return (
		<div className="mtile" role="status" aria-label={`${u.name}: ${proc ? 'processing' : `uploading, ${u.pct}%`}`} data-upload={u.id}>
			{u.preview ? (
				<span className="ph">
					<span style={{ position: 'absolute', inset: 0, opacity: 0.55 }}>
						<img className="ph-img" src={u.preview} alt="" />
					</span>
					<span className="mbar">
						<i style={{ ['--p' as string]: `${u.pct}%` }} />
					</span>
				</span>
			) : (
				<span className="ph pending">
					{u.kind === 'clip' ? <Icon name="film" /> : extOf(u.name)}
					<span className={`mbar${proc ? ' busy' : ''}`} style={{ ['--p' as string]: `${u.pct}%` }}>
						<i />
					</span>
				</span>
			)}
			<span className="nm">{u.name}</span>
			<span className="mt">{proc ? 'Processing: under a minute' : u.pct ? `Uploading${u.kind === 'clip' ? ' to Mux' : ''} · ${u.pct}%` : 'Waiting…'}</span>
		</div>
	);
}

function FailedTile({ upload: u }: { upload: MediaUpload }) {
	const editor = useEditor();
	const media = mediaFor(editor);
	return (
		<div className="mfail" role="group" aria-label={`${u.name}, failed`}>
			<span className="ph pending">
				<Icon name="warn" />
			</span>
			<div>
				<b>{u.name}</b>
				<p>{u.error}</p>
			</div>
			<button type="button" className="ib" aria-label="Dismiss" onClick={() => media.dismissUpload(u.id)} style={{ gridColumn: 2, justifySelf: 'end' }}>
				<Icon name="x" size="sm" />
			</button>
		</div>
	);
}

/** An image's (or a clip's) own level: the picture, its facts, where it's used, the alt text already used for it. */
function ItemLevel({ view }: { view: MediaView }) {
	const editor = useEditor();
	const media = mediaFor(editor);
	const images = useStore(media.images, (l) => l.list);
	const clips = useStore(media.clips, (l) => l.list);
	const documents = useStore(editor.documents);
	const item = view.item!;
	const clip = item.startsWith('clip:');
	const x = useMemo(() => (clip ? (clips ?? []).find((c) => clipId(c) === item) : (images ?? []).find((i) => i.key === item)) ?? null, [clip, clips, images, item]);
	const count = clip ? (clips?.length ?? 0) : (images?.length ?? 0);
	const back = () => editor.goUp();
	if (!x) {
		return (
			<>
				<Trail>
					<DocumentsTab />
					<CurrentHead back={{ label: 'Back to Media', onClick: back }} crumb="Media" title={clip ? 'A clip' : (item.split('/').pop() ?? item)} />
				</Trail>
				<div className="side-body">
					<GlobalNotes />
				</div>
				<RecentStrip />
			</>
		);
	}
	const name = 'key' in x ? x.name : (x.title ?? 'A clip');
	const size = x.w && x.h ? `${x.w} × ${x.h}` : '';
	const uploadedAt = 'key' in x ? x.uploadedAt : x.createdAt;
	const zone = timeZoneOf(editor);
	const uses = x.usedIn;
	const iconOf = (collection: string) => (collection === 'settings' ? 'gear' : collection === 'shared' ? 'shared' : editor.site.collections.find((c) => c.name === collection)?.kind === 'fields' ? 'case' : 'page');
	return (
		<>
			<Trail>
				<DocumentsTab />
				<LevelTab name="Media" kind={clip ? 'Clips' : 'Images'} count={String(count)} onClick={back} />
				<CurrentHead back={{ label: 'Back to Media', onClick: back }} crumb="Media" title={name} sub={`${size}${size ? ' · ' : ''}${'key' in x ? extOf(x.key) : fmtDur(x.duration)}`} />
			</Trail>
			<div className="side-body" data-media-item={item}>
				<GlobalNotes />
				<div className="mdetail">
					<span className="ph" style={{ ['--r' as string]: x.w && x.h ? (x.w / x.h).toFixed(4) : '1.5' }}>
						{'key' in x ? <img className="ph-img" src={x.thumbnail2x} alt="" /> : x.playbackId ? <img className="ph-img" src={clipStill(x.playbackId, 0, 640)} alt="" /> : null}
					</span>
				</div>
				<dl className="kv">
					<dt>Uploaded</dt>
					<dd>
						{uploadedAt ? when(uploadedAt, zone, new Date().toISOString()) : 'Not known'}
						{'key' in x && x.by && x.by !== 'setup' ? ` by ${x.by}` : ''}
					</dd>
					{size ? (
						<>
							<dt>Size</dt>
							<dd>
								{size} pixels{'key' in x ? '' : `, ${fmtDur(x.duration)}`}
							</dd>
						</>
					) : null}
					<dt>{clip ? 'Playback ID' : 'Key'}</dt>
					<dd>
						<span className="mono">{'key' in x ? x.key : (x.playbackId ?? '')}</span>
					</dd>
				</dl>
				{'key' in x ? (
					<div className="file-acts">
						<button type="button" className="btn sm" data-act="image-replace" onClick={() => openDialog(editor, { kind: 'replace', key: x.key })}>
							<FieldIcon name="swap" size="sm" />
							Replace…
						</button>
					</div>
				) : null}
				<p className="sec-h">{uses.length ? `Used on ${uses.length}` : 'Not used anywhere'}</p>
				{uses.length ? (
					<div className="uses">
						{uses.map((u) => (
							<button key={`${u.collection}/${u.path}`} type="button" className="drow" data-use={`${u.collection}/${u.path}`} onClick={() => void editor.openDocument({ collection: u.collection, path: u.path })}>
								<Icon name={iconOf(u.collection)} />
								<span className="nm">{documents.find((d) => d.collection === u.collection && d.path === u.path)?.label ?? u.title}</span>
								<Icon name="chev-r" size="sm" />
							</button>
						))}
					</div>
				) : (
					<p className="field-help">Not used anywhere.</p>
				)}
				{'key' in x ? (
					<>
						<p className="sec-h">Alt text already used for it</p>
						{x.alt ? (
							<div className="alt-used">
								<q>{x.alt}</q>
							</div>
						) : (
							<div className="alt-used">
								<small style={{ margin: 0 }}>None yet.</small>
							</div>
						)}
					</>
				) : null}
			</div>
			<RecentStrip />
		</>
	);
}
