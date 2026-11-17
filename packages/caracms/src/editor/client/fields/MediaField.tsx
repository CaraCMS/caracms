/**
 * The media field (M5b Phase 3; Decisions 3, 6, 7, 8 and 12; the mockup's #media-empty,
 * #media-drop, #media-upload, #media-image, #media-decorative, #focal, #focal-unset,
 * #media-clip, #media-processing, #media-failed, #media-only, #media-unset). One slot holds
 * an image or a clip, one kind at a time:
 *
 * - **Empty**: a drop target, and Choose… (the library as a picker: pane/levels/MediaLevel.tsx).
 * - **An image**: its card (the thumbnail with its focal point, the file, its size, "Focal
 *   point set"), Replace…, Focal point, Remove; then its alt text with **Decorative** on the
 *   label's row (ticked, the alt input empties and turns off, and nothing warns).
 * - **The focal point** (Decision 8) on the image's own preview: a click or a drag puts it,
 *   the arrow keys move it 5% a press, Reset to centre clears it; stored rounded to two
 *   places. The ring moves at once; the value (and so the stage's next render, with new
 *   signed URLs and cold imgproxy renders) follows on a short debounce, and at once when
 *   the pointer lifts or focus leaves.
 * - **A clip**: its poster, title and length, Replace…, Poster (the clip's own preview,
 *   scrubbed, and "Use this frame"), Remove; Plays as Loop / Player (none in a loop-only
 *   slot, which says screen readers skip it); the name screen readers hear only for a player.
 * - **Uploading, processing, failed** (the store's upload for this slot), a refusal in red.
 * - **Media not set up**: the 503's sentence in place of the controls (Decision 5).
 *
 * Remove only clears the slot (with Undo); nothing leaves the library. In a list (the
 * gallery) the slot is a row's body (ListField.tsx), and Remove removes the row.
 * Thumbnails always come from the server's signed imgproxy URL (never the original:
 * Chrome can't show a HEIC), through `thumbnailSrc`.
 *
 * - **Alt text asked for after placing** (M5b Phase 4, Decision 9; #alt-ask): an image
 *   placed (picked or uploaded) with no alt text focuses the slot's alt input with the
 *   ask, in the tool's blue. Typing answers it; leaving it empty (a blur, Skip for now)
 *   turns it into the amber warning (#alt-missing), which stays while `alt` is empty.
 *   Several picked at once into a gallery are asked in turn (`altAskFor`). Not for a
 *   decorative image, a clip, or a brand slot.
 * - **A brand slot** (`brand`: Site Settings' logo and tab icon, Decision 11;
 *   #settings-brand): image-only, compact, the whole picture, with no alt input and no
 *   focal point.
 *
 * `[data-alt="<path>"]` is the slot's alt input and `[data-path="<path>"]` its wrapper
 * (Publish's Add alt text focuses them: live/publish.tsx).
 */
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { FieldWarning, MediaField as MediaDescriptor } from '../../../fields.ts';
import { muxMp4, parseMedia, type ClipValue, type ImageValue, type MediaValue } from '../../../media-value.ts';
import { useEditor, useStore } from '../context.tsx';
import type { Editor } from '../editor.ts';
import { clipStill, mediaFor, slotKey, thumbnailSrc, type MediaUpload, type SlotTarget } from '../media/store.ts';
import { createStore, type Store } from '../state/store.ts';
import { Icon } from '../shell/Icons.tsx';
import { blockLabel, PAGE_SCOPE } from '../state/document-store.ts';
import { pageFieldsLabel } from '../documents/actions.ts';
import { FieldFrame } from './FieldFrame.tsx';
import { useFieldWarnings, useHost } from './host.tsx';
import { Warnings } from './parts.tsx';

const TAKES = 'JPEG, PNG, WebP, AVIF, HEIC, GIF or SVG';

/** The field's meta: what the slot takes. */
export const slotKinds = (field: Pick<MediaDescriptor, 'only' | 'play'>) =>
	field.only === 'image' ? 'Images only' : field.only === 'video' ? 'Clips only' : field.play === 'loop' ? 'Image or loop' : 'Image or clip';

const pad2 = (n: number) => String(n).padStart(2, '0');
export const fmtDur = (s: number | null | undefined) => `${Math.floor((s || 0) / 60)}:${pad2(Math.round((s || 0) % 60))}`;
export const fmtT = (s: number | null | undefined) => `${Math.floor((s || 0) / 60)}:${pad2(Math.floor((s || 0) % 60))}.${Math.round(((s || 0) % 1) * 10) % 10}`;
export const extOf = (name: string) => ((/\.(\w+)$/.exec(name) ?? [, ''])[1] ?? '').toUpperCase().replace('JPEG', 'JPG');
export const fileOfKey = (key: string) => key.split('/').pop() ?? key;
const pct = (v: number) => Math.round(v * 100);
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * The slot whose alt text is being asked for (Decision 9: after an image with no alt text
 * is placed), by slotKey, with its path and the placement's number so each placement
 * focuses once. Null once answered, skipped or left.
 *
 * Several images picked in a row from a list's Add image (the gallery) are asked in turn,
 * in the order picked: Done opens the first one's row, and Enter or Tab in its alt input,
 * Skip for now or Decorative opens the next. Leaving for anything else ends the run, and
 * the rest show the amber warning, as one image left empty does.
 */
type AltAsk = { slot: string; scope: string; path: string; n: number } | null;
const asks = new WeakMap<Editor, { store: Store<AltAsk>; queue: NonNullable<AltAsk>[] }>();
const listOf = (path: string) => path.slice(0, path.lastIndexOf('.'));
function asksFor(editor: Editor) {
	let entry = asks.get(editor);
	if (!entry) {
		const made = { store: createStore<AltAsk>(null), queue: [] as NonNullable<AltAsk>[] };
		entry = made;
		asks.set(editor, made);
		mediaFor(editor).placed.subscribe((p) => {
			if (!p) return;
			const slot = slotKey(p);
			const rest = made.queue.filter((q) => q.slot !== slot);
			const ask = p.kind === 'image' && p.alt === '' ? { slot, scope: p.scope, path: p.path, n: p.n } : null;
			// One of a run of picks in the same list joins the queue; anything else starts afresh.
			const head = rest[0];
			const sameRun = p.multi && !!head && head.scope === p.scope && listOf(head.path) === listOf(p.path);
			made.queue = sameRun ? (ask ? [...rest, ask] : rest) : ask ? [ask] : [];
			made.store.set(made.queue[0] ?? null);
		});
	}
	return entry;
}
export function altAskFor(editor: Editor): Store<AltAsk> {
	return asksFor(editor).store;
}

/**
 * The ask for `slot` ends: with `next`, the queue's next image is asked (returned, so the
 * caller opens its row); without, the whole run ends. Nothing happens unless `slot` is the
 * one being asked.
 */
function endAltAsk(editor: Editor, slot: string, next: boolean): AltAsk {
	const asks = asksFor(editor);
	if (asks.store.get()?.slot !== slot) return null;
	asks.queue = next ? asks.queue.slice(1) : [];
	asks.store.set(asks.queue[0] ?? null);
	return asks.store.get();
}

/** The block's (or form's) name, for the picker's trail and sub line: "Text and media", "High-street coffee roaster". */
export function ownerOf(editor: Editor, scope: string): { owner: string; back: 'block' | 'document' } {
	const session = editor.doc.get();
	// M6: a page's own share image (SEO_SCOPE), at its document level.
	if (scope === 'seo') return { owner: 'SEO', back: 'document' };
	// M6c (G2): a section builder's page fields, at its document level too.
	if (scope === PAGE_SCOPE) {
		const collection = editor.site.collections.find((c) => c.name === session.ref.collection);
		return { owner: collection ? pageFieldsLabel(collection) : 'Page details', back: 'document' };
	}
	if (session.document.kind === 'sections') {
		const block = editor.doc.block(scope);
		return { owner: block ? blockLabel(editor.site, block) : 'Block', back: 'block' };
	}
	return { owner: session.document.title || session.entry.label, back: 'document' };
}

/** The media field at the top level of a block or a form: its frame and its slot. */
export function MediaField(props: { name: string; label: string; field: MediaDescriptor; value: unknown }) {
	const host = useHost();
	const warnings = useFieldWarnings(props.name, props.field, props.value);
	return (
		<FieldFrame blockKey={host.scope} name={props.name} label={props.label} help={props.field.help} className="media-field" meta={<span className="field-meta">{slotKinds(props.field)}</span>}>
			<MediaSlot path={props.name} field={props.field} value={props.value} warnings={warnings} pickLabel={props.label} />
		</FieldFrame>
	);
}

/**
 * One slot's body: in a field's frame, or a gallery row's (`row`: the list's path and the
 * row's index, so Remove removes the row). `warnings` are relative to the slot (`''`, `'alt'`).
 */
export function MediaSlot(props: {
	path: string;
	field: MediaDescriptor;
	value: unknown;
	warnings: readonly FieldWarning[];
	/** The field's label for the picker's sub line ("Image or video", "Images, image 3"). */
	pickLabel: string;
	row?: { list: string; index: number; label: string };
	/** Site Settings' logo or tab icon (Decision 11): image-only, compact, no alt input, no focal point. */
	brand?: { label: string };
	/** M6: a share image (Decision 13): an image with a focal point but no alt input (it's never on the page). */
	noAlt?: boolean;
}) {
	const editor = useEditor();
	const host = useHost();
	const media = mediaFor(editor);
	// Made before any placement, so the first placement's ask is seen.
	altAskFor(editor);
	const { path, field } = props;
	const setup = useStore(editor.mediaSetup);
	const upload = useStore(media.uploads, (list) => list.find((u) => u.slot === slotKey({ scope: host.scope, path })) ?? null);
	const note = useStore(media.slotNotes, (map) => map.get(slotKey({ scope: host.scope, path })) ?? null);
	const value = parseMedia(props.value);
	const target: SlotTarget = { scope: host.scope, path, only: field.only, play: field.play, altFrom: field.altFrom };
	const ro = host.readOnly;
	// The library answers where a key came from (its name) and a clip's title; read once, kept as last known.
	useEffect(() => {
		if (value && 'key' in value && media.images.get().list === null) void media.loadImages();
		if (value && 'video' in value && media.clips.get().list === null) void media.loadClips();
	}, [media, value && ('key' in value ? value.key : value.video)]);

	const choose = () => {
		if (ro) return;
		const { owner, back } = ownerOf(editor, host.scope);
		editor.openMedia({
			pick: { scope: host.scope, path, only: field.only, play: field.play, altFrom: field.altFrom, label: `${owner} · ${props.pickLabel}`, owner, multi: false, back },
			tab: value && 'video' in value ? 'clips' : 'images',
		});
	};
	const remove = () => {
		if (ro || !value) return;
		const title = 'key' in value ? fileOfKey(value.key) : 'the clip';
		if (props.row) host.removeItem(props.row.list, props.row.index, `Removed ${props.row.label}: ${title}`);
		else {
			host.set(path, null, { undoLabel: `Removed ${title}` });
			editor.announce(`Removed ${title}.`);
		}
	};
	const write = (next: MediaValue) => host.set(path, parseMedia(next));
	const drop = useDrop((files) => !ro && media.upload(files, target));

	// The image routes answer 503: the sentence in place of the controls (a clip-only slot needs Mux's).
	const unset = field.only === 'video' ? setup.clips : value && 'video' in value ? setup.clips : setup.images;
	if (unset) {
		return (
			<div className="mslot" data-path={path} tabIndex={-1}>
				<div className="note tight" data-media-unset="">
					<Icon name="media" />
					<div>
						<b>Media isn't set up on this server yet</b>
						<p>{unset.error}</p>
					</div>
				</div>
			</div>
		);
	}

	let body: ReactNode;
	if (upload && upload.phase === 'failed') body = null;
	else if (upload) body = <UploadCard upload={upload} onCancel={() => media.dismissUpload(upload.id)} />;
	else if (props.brand) body = value && 'key' in value ? <BrandCard value={value} label={props.brand.label} readOnly={ro} onChoose={choose} onRemove={remove} drop={drop} /> : <BrandDrop readOnly={ro} onChoose={choose} drop={drop} />;
	else if (value && 'key' in value) body = <ImageCard value={value} path={path} readOnly={ro} warnings={props.warnings} onChoose={choose} onRemove={remove} write={write} drop={drop} noAlt={props.noAlt} />;
	else if (value && 'video' in value) body = <ClipCard value={value} path={path} loopOnly={field.play === 'loop'} readOnly={ro} onChoose={choose} onRemove={remove} write={write} drop={drop} />;
	else body = <DropZone only={field.only} readOnly={ro} onChoose={choose} drop={drop} />;

	return (
		<div className="mslot" data-path={path} tabIndex={-1}>
			{upload?.phase === 'failed' ? (
				<div className="note danger tight" role="alert" style={{ marginBottom: 'var(--space-2)' }}>
					<Icon name="warn" />
					<div>
						<b>{upload.name} couldn't be made ready to play</b>
						<p>{upload.error}</p>
						<div className="acts">
							<button type="button" className="btn sm" disabled={ro} onClick={choose}>
								Choose another…
							</button>
							<button type="button" className="btn sm ghost" onClick={() => media.dismissUpload(upload.id)}>
								Dismiss
							</button>
						</div>
					</div>
				</div>
			) : null}
			{body}
			{upload?.phase === 'failed' && !value ? <DropZone only={field.only} readOnly={ro} onChoose={choose} drop={drop} /> : null}
			{note ? (
				<p className="field-err" role="alert">
					<Icon name="warn" size="sm" />
					<span>{note}</span>
				</p>
			) : null}
			<Warnings warnings={props.warnings.filter((w) => w.path === '')} />
		</div>
	);
}

/** Drag-and-drop of files onto a slot (or the library): `over` while a file is held over it. */
export function useDrop(onFiles: (files: File[]) => void) {
	const [over, setOver] = useState(false);
	const depth = useRef(0);
	const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files');
	return {
		over,
		props: {
			onDragEnter(event: DragEvent) {
				if (!hasFiles(event)) return;
				event.preventDefault();
				depth.current += 1;
				setOver(true);
			},
			onDragOver(event: DragEvent) {
				if (!hasFiles(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = 'copy';
			},
			onDragLeave(event: DragEvent) {
				if (!hasFiles(event)) return;
				depth.current = Math.max(0, depth.current - 1);
				if (depth.current === 0) setOver(false);
			},
			onDrop(event: DragEvent) {
				if (!hasFiles(event)) return;
				event.preventDefault();
				event.stopPropagation();
				depth.current = 0;
				setOver(false);
				const files = [...(event.dataTransfer?.files ?? [])];
				if (files.length) onFiles(files);
			},
		},
	};
}

type Drop = ReturnType<typeof useDrop>;

function DropZone(props: { only?: 'image' | 'video'; readOnly: boolean; onChoose: () => void; drop: Drop }) {
	const what = props.only === 'image' ? 'an image' : props.only === 'video' ? 'a clip' : 'an image or a clip';
	const fine = props.only === 'image' ? `${TAKES}, up to 40 MB` : `Images: ${TAKES}, up to 40 MB.`;
	return (
		<div className={`mdrop${props.drop.over ? ' is-over' : ''}`} data-drop="" {...(props.readOnly ? {} : props.drop.props)}>
			<Icon name="upload" />
			<b>
				<span className="when-idle">Drop {what} here</span>
				<span className="when-over">Drop to upload</span>
			</b>
			<span className="or">
				or{' '}
				<button type="button" className="btn sm" disabled={props.readOnly} onClick={props.onChoose}>
					<Icon name="media" size="sm" />
					Choose…
				</button>{' '}
				from the library
			</span>
			<span className="fine">{fine}</span>
		</div>
	);
}

/** A brand slot, empty (#settings-brand): a small drop target and Choose…. */
function BrandDrop(props: { readOnly: boolean; onChoose: () => void; drop: Drop }) {
	return (
		<div className={`mdrop sm${props.drop.over ? ' is-over' : ''}`} data-drop="" {...(props.readOnly ? {} : props.drop.props)}>
			<Icon name="upload" />
			<span className="t">
				<span className="when-idle">Drop an image here</span>
				<span className="when-over">Drop to upload</span>
			</span>
			<button type="button" className="btn sm" disabled={props.readOnly} onClick={props.onChoose}>
				Choose…
			</button>
		</div>
	);
}

/** A brand slot with its image (#settings-brand): the whole picture (a logo isn't cropped), its file and size, Replace… and Remove. No alt, no focal point. */
function BrandCard(props: { value: ImageValue; label: string; readOnly: boolean; onChoose: () => void; onRemove: () => void; drop: Drop }) {
	const editor = useEditor();
	const media = mediaFor(editor);
	const { value, readOnly: ro } = props;
	const name = useStore(media.images, (l) => l.list?.find((x) => x.key === value.key)?.name ?? null) ?? fileOfKey(value.key);
	const thumb = thumbnailSrc(value.key, 160);
	return (
		<div className="media compact" {...(ro ? {} : props.drop.props)}>
			<div className="media-main">
				<span className="thumb ph contain" style={value.w && value.h ? { ['--r' as string]: (value.w / value.h).toFixed(4) } : undefined}>
					<img className="ph-img" src={thumb} srcSet={`${thumb} 1x, ${thumbnailSrc(value.key, 320)} 2x`} alt="" />
				</span>
				<div className="media-txt">
					<b title={value.key}>{name}</b>
					<small>
						{value.w && value.h ? `${value.w} × ${value.h} · ` : ''}
						{extOf(value.key)}
					</small>
				</div>
				<button type="button" className="btn sm" disabled={ro} onClick={props.onChoose}>
					Replace…
				</button>
				<button type="button" className="ib" disabled={ro} aria-label={`Remove the ${props.label.toLowerCase()}`} onClick={props.onRemove}>
					<Icon name="x" size="sm" />
				</button>
			</div>
		</div>
	);
}

/** An upload in the slot: real progress, then Mux's processing for a clip. The file's own picture when the browser can show it. */
export function UploadCard({ upload, onCancel }: { upload: MediaUpload; onCancel: () => void }) {
	const clip = upload.kind === 'clip';
	const proc = upload.phase === 'proc';
	const line = proc ? 'Processing: getting it ready to play' : `Uploading${clip ? ' to Mux' : ''} · ${upload.pct}%`;
	const note = proc ? 'Usually under a minute.' : clip ? 'Keep this tab open until it’s done.' : null;
	return (
		<div className="media" role="status">
			<div className="media-main">
				{upload.preview ? (
					<span className={`thumb${clip ? ' wide' : ''} ph`} style={{ opacity: 0.6 }}>
						<img className="ph-img" src={upload.preview} alt="" />
					</span>
				) : (
					<span className={`thumb${clip ? ' wide' : ''} ph pending`}>{clip ? <Icon name="film" /> : extOf(upload.name)}</span>
				)}
				<div className="media-txt">
					<b>{upload.name}</b>
					<small>{line}</small>
				</div>
				{proc ? null : (
					<button type="button" className="btn sm ghost" onClick={onCancel}>
						Cancel
					</button>
				)}
			</div>
			<div className="media-prog">
				<div className={`mbar${proc ? ' busy' : ''}`} style={{ ['--p' as string]: `${upload.pct}%` }}>
					<i />
				</div>
				{note ? <p>{note}</p> : null}
			</div>
		</div>
	);
}

function ImageCard(props: {
	value: ImageValue;
	path: string;
	readOnly: boolean;
	warnings: readonly FieldWarning[];
	onChoose: () => void;
	onRemove: () => void;
	write: (next: MediaValue) => void;
	drop: Drop;
	noAlt?: boolean;
}) {
	const editor = useEditor();
	const media = mediaFor(editor);
	const { value, path, readOnly: ro } = props;
	const [focalOpen, setFocalOpen] = useState(false);
	const name = useStore(media.images, (l) => l.list?.find((x) => x.key === value.key)?.name ?? null) ?? fileOfKey(value.key);
	const focal = value.focal ?? null;
	const thumb = thumbnailSrc(value.key, 320);
	return (
		<>
			<div className="media" {...(ro ? {} : props.drop.props)}>
				<div className="media-main">
					<button type="button" className="thumb ph" aria-label="Focal point" aria-expanded={focalOpen} disabled={ro} onClick={() => setFocalOpen(!focalOpen)}>
						<img className="ph-img" src={thumb} srcSet={`${thumb} 1x, ${thumbnailSrc(value.key, 640)} 2x`} alt="" style={focal ? { objectPosition: `${pct(focal[0])}% ${pct(focal[1])}%` } : undefined} />
						{focal ? <span className="fp-dot" style={{ left: `${pct(focal[0])}%`, top: `${pct(focal[1])}%` }} /> : null}
					</button>
					<div className="media-txt">
						<b title={value.key}>{name}</b>
						<small>
							{value.w && value.h ? `${value.w} × ${value.h} · ` : ''}
							{extOf(value.key)}
						</small>
						<small className={focal ? 'fp-on' : ''}>
							<Icon name="target" size="xs" />
							{focal ? 'Focal point set' : 'No focal point'}
						</small>
					</div>
				</div>
				<div className="media-acts">
					<button type="button" className="btn sm" disabled={ro} onClick={props.onChoose}>
						Replace…
					</button>
					<button type="button" className="btn sm" aria-expanded={focalOpen} disabled={ro} onClick={() => setFocalOpen(!focalOpen)}>
						<Icon name="target" size="sm" />
						Focal point
					</button>
					<button type="button" className="btn sm ghost end" disabled={ro} onClick={props.onRemove}>
						Remove
					</button>
				</div>
			</div>
			{focalOpen ? <FocalEditor value={value} readOnly={ro} write={props.write} /> : null}
			{props.noAlt ? null : <AltText value={value} path={path} readOnly={ro} warnings={props.warnings} write={props.write} />}
		</>
	);
}

const fpVal = (f: readonly [number, number] | null) => (f ? `${pct(f[0])}% across · ${pct(f[1])}% down` : 'The centre (not set)');
const fpLabel = (f: readonly [number, number] | null) =>
	`Focal point: ${f ? `${pct(f[0])}% from the left, ${pct(f[1])}% from the top` : 'not set, so the centre'}. Click or drag on the picture, or use the arrow keys.`;

/** How long the stage waits after the last move before it renders the new focal point (each render signs new URLs). */
export const FOCAL_DEBOUNCE_MS = 200;

/**
 * The focal point on the image's own preview (Decision 8). The ring follows the pointer
 * and the keys at once (local state); the value follows FOCAL_DEBOUNCE_MS after the last
 * move, and at once when the pointer lifts or focus leaves.
 */
function FocalEditor(props: { value: ImageValue; readOnly: boolean; write: (next: MediaValue) => void }) {
	const { value, readOnly: ro } = props;
	const [draft, setDraft] = useState<[number, number] | null | undefined>(undefined);
	const [dragging, setDragging] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pending = useRef<{ f: [number, number] | null } | null>(null);
	const latest = useRef(props);
	latest.current = props;
	const shown = draft !== undefined ? draft : (value.focal ?? null);

	const flush = () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		const p = pending.current;
		pending.current = null;
		if (!p) return;
		const { value: v, write } = latest.current;
		const next: ImageValue = { ...v };
		if (p.f) next.focal = p.f;
		else delete next.focal;
		write(next);
		setDraft(undefined);
	};
	useEffect(() => () => flush(), []);

	const put = (f: [number, number] | null, now = false) => {
		if (ro) return;
		const rounded: [number, number] | null = f ? [round2(clamp01(f[0])), round2(clamp01(f[1]))] : null;
		setDraft(rounded);
		pending.current = { f: rounded };
		if (timer.current) clearTimeout(timer.current);
		if (now) flush();
		else timer.current = setTimeout(flush, FOCAL_DEBOUNCE_MS);
	};
	const at = (event: PointerEvent<HTMLDivElement>): [number, number] => {
		const r = event.currentTarget.getBoundingClientRect();
		return [(event.clientX - r.left) / r.width, (event.clientY - r.top) / r.height];
	};
	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const step: Record<string, [number, number]> = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, -0.05], ArrowDown: [0, 0.05] };
		const d = step[event.key];
		if (!d || ro) return;
		event.preventDefault();
		const from = shown ?? [0.5, 0.5];
		put([from[0] + d[0], from[1] + d[1]]);
	};
	const ratio = value.w && value.h ? value.w / value.h : 1.5;
	const x = shown ? shown[0] : 0.5;
	const y = shown ? shown[1] : 0.5;
	return (
		<div className="fp">
			<div className="fp-stage">
				<div
					className={`fp-img${dragging ? ' is-dragging' : ''}`}
					tabIndex={ro ? -1 : 0}
					role="group"
					aria-label={fpLabel(shown)}
					aria-disabled={ro ? 'true' : undefined}
					data-focal=""
					style={{ ['--r' as string]: ratio.toFixed(4) }}
					onPointerDown={(event) => {
						if (ro || event.button !== 0) return;
						event.currentTarget.setPointerCapture(event.pointerId);
						event.currentTarget.focus({ preventScroll: true });
						setDragging(true);
						put(at(event));
					}}
					onPointerMove={(event) => {
						if (dragging) put(at(event));
					}}
					onPointerUp={(event) => {
						if (!dragging) return;
						setDragging(false);
						put(at(event), true);
					}}
					onPointerCancel={() => {
						setDragging(false);
						flush();
					}}
					onKeyDown={onKey}
					onBlur={flush}
				>
					<img className="ph-img" src={thumbnailSrc(value.key, 640)} alt="" draggable={false} />
					<span className={`fp-ring${shown ? '' : ' unset'}`} style={{ left: `${x * 100}%`, top: `${y * 100}%` }} />
				</div>
			</div>
			<div className="fp-row">
				<span className="fp-val">{fpVal(shown)}</span>
				<button type="button" className="linkbtn subtle" disabled={!shown || ro} onClick={() => put(null, true)}>
					Reset to centre
				</button>
			</div>
			<p className="fp-help">Click what matters most; crops keep it in view.</p>
		</div>
	);
}

/**
 * Alt text with Decorative on its label's row (Decision 3); the ask after placing, then the
 * amber missing-alt warning under it (Decision 9).
 */
function AltText(props: { value: ImageValue; path: string; readOnly: boolean; warnings: readonly FieldWarning[]; write: (next: MediaValue) => void }) {
	const editor = useEditor();
	const host = useHost();
	const media = mediaFor(editor);
	const { value, path, readOnly: ro } = props;
	const id = `alt-${host.scope}-${path}`.replace(/[^\w-]/g, '-');
	const deco = !!value.decorative;
	const missing = props.warnings.filter((w) => w.code === 'missing-alt');
	// Picked with an alt text already used for it: say where it came from while it's unchanged (#library-picked-alt).
	const placed = useStore(media.placed);
	const from = placed && placed.scope === host.scope && placed.path === path && placed.altFrom && placed.alt === value.alt && value.alt ? placed.altFrom : null;
	// The ask after placing (#alt-ask): this slot's, while the alt is still empty and it isn't decorative.
	const askStore = altAskFor(editor);
	const ask = useStore(askStore);
	const mine = slotKey({ scope: host.scope, path });
	const asking = !!ask && ask.slot === mine && !deco && value.alt === '' && !ro;
	const input = useRef<HTMLInputElement>(null);
	const focusedFor = useRef<number | null>(null);
	// Answered, skipped or decorative (`next`): a run's next image is asked, its row opened. Left: the run ends.
	const endAsk = (next: boolean) => {
		const head = endAltAsk(editor, mine, next);
		if (head && head.scope === host.scope) host.pick(head.path);
		return !!head;
	};
	useEffect(() => {
		if (!asking || !ask || focusedFor.current === ask.n) return;
		focusedFor.current = ask.n;
		// The level the slot is in may still be coming on screen: try for a few frames.
		let tries = 20;
		let frame = 0;
		const attempt = () => {
			const el = input.current;
			if (el && el.offsetParent !== null && !el.disabled) {
				el.scrollIntoView({ block: 'nearest' });
				el.focus({ preventScroll: true });
				if (document.activeElement === el) return;
			}
			if (tries-- > 0) frame = requestAnimationFrame(attempt);
		};
		frame = requestAnimationFrame(attempt);
		return () => cancelAnimationFrame(frame);
	}, [asking, ask?.n]);
	return (
		<>
			<div className="alt-head">
				<label className="sub-label" htmlFor={id}>
					Alt text
				</label>
				<label className="deco">
					<input
						type="checkbox"
						checked={deco}
						disabled={ro}
						aria-describedby={`${id}-m`}
						onChange={(e) => {
							const next: ImageValue = { ...value };
							if (e.target.checked) {
								next.decorative = true;
								next.alt = '';
								endAsk(true);
							} else delete next.decorative;
							props.write(next);
						}}
					/>
					Decorative
				</label>
			</div>
			<input
				ref={input}
				className="input alt"
				id={id}
				data-alt={path}
				value={deco ? '' : value.alt}
				placeholder={deco ? 'Decorative' : 'Describe the picture'}
				autoComplete="off"
				aria-describedby={`${id}-m`}
				aria-invalid={missing.length > 0 && !deco && !asking ? 'true' : undefined}
				disabled={ro || deco}
				onChange={(e) => props.write({ ...value, alt: e.target.value.replace(/\n+/g, ' ') })}
				onKeyDown={(e) => {
					// Enter, or Tab, moves on to a run's next image (Tab goes on as usual when there's none).
					if (e.key !== 'Enter' && (e.key !== 'Tab' || e.shiftKey)) return;
					if (askStore.get()?.slot !== mine) return;
					if (endAsk(true) || e.key === 'Enter') e.preventDefault();
				}}
				onBlur={(e) => {
					// Left (within the slot is staying, as for Decorative): the ask ends. Left empty, it turns into the amber warning (#alt-missing).
					if (e.relatedTarget instanceof Node && e.currentTarget.closest('.mslot')?.contains(e.relatedTarget)) return;
					endAsk(false);
				}}
			/>
			<div id={`${id}-m`} data-altmsg="" data-ask={asking ? '' : undefined}>
				{deco ? (
					<p className="field-hint">
						<Icon name="check" size="xs" />
						<span>Screen readers skip it.</span>
					</p>
				) : asking ? (
					<p className="field-ask">
						<Icon name="image" size="sm" />
						<span>
							Describe the picture in a sentence, or tick Decorative.{' '}
							<button
								type="button"
								className="linkbtn subtle"
								data-act="alt-skip"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => endAsk(true)}
							>
								Skip for now
							</button>
						</span>
					</p>
				) : missing.length ? (
					<Warnings warnings={missing} />
				) : from ? (
					<p className="field-hint">
						<Icon name="copy" size="xs" />
						<span>Already used for this image on {from}. Check it fits here too.</span>
					</p>
				) : null}
			</div>
		</>
	);
}

function ClipCard(props: {
	value: ClipValue;
	path: string;
	loopOnly: boolean;
	readOnly: boolean;
	onChoose: () => void;
	onRemove: () => void;
	write: (next: MediaValue) => void;
	drop: Drop;
}) {
	const editor = useEditor();
	const host = useHost();
	const media = mediaFor(editor);
	const { value, path, readOnly: ro } = props;
	const [frameOpen, setFrameOpen] = useState(false);
	const title = useStore(media.clips, (l) => l.list?.find((c) => c.playbackId === value.video)?.title ?? null) ?? 'A clip';
	const play = props.loopOnly ? 'loop' : value.play;
	const id = `nm-${host.scope}-${path}`.replace(/[^\w-]/g, '-');
	return (
		<>
			<div className="media" {...(ro ? {} : props.drop.props)}>
				<div className="media-main">
					<button type="button" className="thumb wide ph" aria-label="Poster frame" aria-expanded={frameOpen} disabled={ro} onClick={() => setFrameOpen(!frameOpen)}>
						<img className="ph-img" src={clipStill(value.video, value.poster)} alt="" />
						<span className="dur">{fmtDur(value.duration)}</span>
					</button>
					<div className="media-txt">
						<b>{title}</b>
						<small>
							{fmtDur(value.duration)}
							{value.w && value.h ? ` · ${value.w} × ${value.h}` : ''} · Clip
						</small>
						<small>
							<Icon name="image" size="xs" />
							Poster: {value.poster !== undefined ? `the frame at ${fmtT(value.poster)}` : 'the first frame'}
						</small>
					</div>
				</div>
				<div className="media-acts">
					<button type="button" className="btn sm" disabled={ro} onClick={props.onChoose}>
						Replace…
					</button>
					<button type="button" className="btn sm" aria-expanded={frameOpen} aria-label="Poster frame" disabled={ro} onClick={() => setFrameOpen(!frameOpen)}>
						<Icon name="image" size="sm" />
						Poster
					</button>
					<button type="button" className="btn sm ghost end" disabled={ro} onClick={props.onRemove}>
						Remove
					</button>
				</div>
			</div>
			{frameOpen ? <FrameEditor value={value} readOnly={ro} write={props.write} /> : null}
			{props.loopOnly ? (
				// A loop-only slot (the hero) has no Plays as: every clip in it loops (Decision 3).
				<p className="field-hint">
					<Icon name="film" size="xs" />
					Silent loop; reduced-motion users see the poster.
				</p>
			) : (
				<>
					<span className="sub-label">Plays as</span>
					<div className="mini-seg" role="radiogroup" aria-label="Plays as">
						{(['loop', 'player'] as const).map((p) => (
							<button key={p} type="button" role="radio" aria-checked={play === p} disabled={ro} onClick={() => play !== p && props.write({ ...value, play: p })}>
								{p === 'loop' ? 'Loop' : 'Player'}
							</button>
						))}
					</div>
					<p className="field-help" style={{ margin: 0 }}>
						{play === 'player'
							? 'Poster with a play button.'
							: 'Silent loop; reduced-motion users see the poster.'}
					</p>
					{play === 'player' ? (
						<>
							<label className="sub-label" htmlFor={id}>
								Name for screen readers
							</label>
							<input
								className="input"
								id={id}
								data-clip-name={path}
								value={value.name ?? ''}
								placeholder="What happens in the clip"
								autoComplete="off"
								disabled={ro}
								onChange={(e) => props.write({ ...value, name: e.target.value.replace(/\n+/g, ' ') })}
							/>
							<p className="field-hint">Read out as “Play video{value.name ? `: ${value.name}` : ''}”.</p>
						</>
					) : null}
				</>
			)}
		</>
	);
}

/** "Use this frame" (Decision 12): the clip's own MP4, scrubbed to a frame, sets `poster` (tenths of a second). */
function FrameEditor(props: { value: ClipValue; readOnly: boolean; write: (next: MediaValue) => void }) {
	const { value, readOnly: ro } = props;
	const [t, setT] = useState(value.poster ?? 0);
	const video = useRef<HTMLVideoElement>(null);
	const duration = value.duration ?? 0;
	useEffect(() => {
		if (video.current && Number.isFinite(t)) video.current.currentTime = t;
	}, [t]);
	const chosen = Math.round(t * 10) / 10;
	return (
		<div className="fr">
			<div className="fr-vid ph">
				<video ref={video} src={muxMp4(value.video)} poster={clipStill(value.video, value.poster, 640)} muted playsInline preload="metadata" aria-label="The clip, at the frame chosen" />
				<span className="fr-time">
					{fmtT(t)} / {fmtDur(duration)}
				</span>
			</div>
			<input type="range" className="fr-range" min={0} max={duration || 0} step={0.1} value={t} aria-label="Find a frame" disabled={ro} onChange={(e) => setT(Number(e.target.value))} />
			<div className="fr-row">
				<span>{value.poster !== undefined ? `Poster: the frame at ${fmtT(value.poster)}` : 'Poster: the first frame'}</span>
				<button type="button" className="btn sm" disabled={ro || chosen === value.poster} onClick={() => props.write({ ...value, poster: chosen })}>
					Use this frame
				</button>
			</div>
		</div>
	);
}
