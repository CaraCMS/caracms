/**
 * M6c (G5): a flat collection's documents as a grid of cards over the stage, beside
 * the table (CollectionTable.tsx draws the head, the find, filters, order and the
 * switch; the rows here are the same view's: viewRows). Mockup: m6c-downloads-grid.html
 * → #grid, #grid-text, #grid-loading.
 *
 * A card is the sidebar's row grown up: its picture, the title with the row's marks,
 * and up to two captions (table.ts → captionColumns). The picture arrives already
 * cropped to the collection's ratio by the server, signed, in the listing
 * (`doc.card`, editor/server/cards.ts): the box holds the ratio before it lands (no
 * layout shift, no skeleton) and the image fades in once, when it has loaded. No
 * picture: the text card, the title set in the picture's place. Someone's lock is a
 * chip on the picture; the open document is a wash with a full ring (no side rails).
 */
import type { CSSProperties } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { Icon } from '../shell/Icons.tsx';
import { docIcon } from '../nav/DocRow.tsx';
import { Avatar, DocMarksView } from '../live/marks.tsx';
import { displayName } from '../live/format.ts';
import { fmtDur } from '../fields/MediaField.tsx';
import { docId, warnedWords, type CardPicture, type EditorAnyCollection, type ListedDocument } from '../../types.ts';
import { ratioValue } from '../../../cards.ts';
import { cellText, type RefIndex, type TableColumn } from './table.ts';

export function CollectionGrid(props: {
	collection: EditorAnyCollection;
	rows: readonly ListedDocument[];
	captions: readonly TableColumn[];
	currentId: string;
	edited: (ms: number) => string;
	/** Every listed document, for a reference caption's title (table.ts → refIndex). */
	refs: RefIndex;
	open: (doc: ListedDocument) => void;
	/** Review gaps (Decision 3): a manual collection's card says its place in Site order, before its first caption. */
	position?: (doc: ListedDocument) => number;
}) {
	const ratio = props.collection.view?.ratio ?? '4:3';
	const style = { '--card-ratio': String(ratioValue(ratio)) } as CSSProperties;
	return (
		<div className="cgrid" data-ratio={ratio} style={style}>
			{props.rows.map((d) => (
				<Card key={d.path} doc={d} collection={props.collection} captions={props.captions} current={docId(d) === props.currentId} edited={props.edited} refs={props.refs} open={props.open} position={props.position?.(d)} />
			))}
		</div>
	);
}

function Card(props: { doc: ListedDocument; collection: EditorAnyCollection; captions: readonly TableColumn[]; current: boolean; edited: (ms: number) => string; refs: RefIndex; open: (doc: ListedDocument) => void; position?: number }) {
	const editor = useEditor();
	const { doc } = props;
	const id = `card-${docId(doc).replace(/[^a-zA-Z0-9-]/g, '-')}`;
	const live = editor.mode === 'live';
	return (
		<button
			type="button"
			className={['card', props.current ? 'is-current' : '', doc.warning ? 'is-warned' : ''].filter(Boolean).join(' ')}
			data-doc={docId(doc)}
			aria-current={props.current ? 'page' : undefined}
			aria-labelledby={`${id}-t`}
			aria-describedby={props.captions.length || props.position !== undefined ? `${id}-c` : undefined}
			title={doc.warning?.message}
			onClick={() => props.open(doc)}
		>
			<span className="card-pic">
				{doc.card ? <Picture card={doc.card} /> : (
					<span className="ph tcard" data-card="text">
						<Icon name={docIcon(props.collection)} />
						<span className="tc-t">{doc.label}</span>
					</span>
				)}
				{live ? <CardLock file={doc.file} /> : null}
			</span>
			<span className="card-txt">
				<span className="card-t" id={`${id}-t`}>
					<span className="nm">{doc.label}</span>
					<span className="meta">
						{doc.warning ? (
							<span className="wmark" data-warning={doc.warning.code} title={doc.warning.message}>
								<Icon name="warn" size="xs" />
								<span className="sr">{warnedWords(doc)}: {doc.warning.message}</span>
							</span>
						) : null}
						{live ? <DocMarksView file={doc.file} compact lock={false} /> : null}
						{live ? <CardLock file={doc.file} sr /> : null}
					</span>
				</span>
				{props.captions.length || props.position !== undefined ? (
					<span id={`${id}-c`} className="card-cs">
						{props.position !== undefined && !props.captions.some((c) => cellText(doc, c, props.edited, props.refs)) ? (
							<span className="card-c" data-position={props.position}>
								{props.position}
							</span>
						) : null}
						{props.captions.map((c) => {
							const text = cellText(doc, c, props.edited, props.refs);
							const words = c.kind === 'edited' ? `Edited ${text}` : text;
							const first = text && props.position !== undefined && props.captions.find((k) => cellText(doc, k, props.edited, props.refs)) === c;
							return text ? (
								<span key={c.key} className={`card-c${c.kind === 'address' ? ' mono' : ''}`} data-position={first ? props.position : undefined}>
									{first ? `${props.position} · ${words}` : words}
								</span>
							) : null;
						})}
					</span>
				) : null}
			</span>
		</button>
	);
}

/** The picture: an `<img>` at the card's ratio from the listing's signed URLs, which fades in once it has loaded (at once if it already had). */
function Picture({ card }: { card: CardPicture }) {
	return (
		<span className="ph" data-card={card.kind}>
			<img
				key={card.src}
				className="ph-img card-img"
				src={card.src}
				srcSet={`${card.src} 1x, ${card.src2x} 2x`}
				alt={card.alt}
				loading="lazy"
				decoding="async"
				style={card.kind === 'image' && card.position ? { objectPosition: card.position } : undefined}
				ref={(img) => {
					if (img?.complete && img.naturalWidth > 0) img.classList.add('in', 'now');
				}}
				onLoad={(e) => e.currentTarget.classList.add('in')}
			/>
			{card.kind === 'clip' ? (
				<span className="pbadge" title="A clip’s poster">
					<Icon name="play" />
					{fmtDur(card.duration)}
				</span>
			) : null}
		</span>
	);
}

/** Someone else's lock, said on the picture's top right (`sr`: said only to a screen reader, in the title's marks, so the card's name carries it). */
function CardLock({ file, sr = false }: { file: string; sr?: boolean }) {
	const editor = useEditor();
	const editing = useStore(editor.marks, (all) => all.get(file)?.editing ?? null);
	if (!editing) return null;
	if (sr) return <span className="sr">, {displayName(editing)} is editing</span>;
	return (
		<span className="chip lock card-lock" data-mark="editing" aria-hidden="true">
			<Avatar person={editing} size="sm" />
			{displayName(editing)} is editing
		</span>
	);
}
