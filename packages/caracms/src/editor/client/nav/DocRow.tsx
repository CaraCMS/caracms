/**
 * One document's row (the mockup's `.drow`), wherever documents are listed: the
 * Pages tree, a collection's level, "Find a document" and the switcher.
 *
 * A file that can't be opened (invalid JSON, no title, a nested `index.json`;
 * Decisions 8–9) is listed with a warning mark and doesn't open: clicking it shows
 * why, in a note under the row (`aria-expanded`), and never opens it. No side rails (M2 Decision 10): the current row is a
 * wash with a full thin ring, a warned one an icon.
 *
 * M4 (live mode): the merge notice's mark, someone's lock ("Aoife is editing"),
 * presence (avatars) and the waiting dot go in the row's meta (live/marks.tsx). In
 * local mode the slot stays empty (`data-slot="presence"`).
 */
import { useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { Icon } from '../shell/Icons.tsx';
import { docId, opensInEditor, sameDoc, warnedWords, type ListedDocument } from '../../types.ts';
import { DocMarksView } from '../live/marks.tsx';

/** A document's icon by its collection: a page, a case study (any list-of-fields document), a shared block, Site Settings, else a post. */
export function docIcon(collection: { nested: boolean; kind?: string } | undefined): string {
	if (collection?.nested) return 'page';
	if (collection?.kind === 'fields') return 'case';
	if (collection?.kind === 'shared') return 'shared';
	if (collection?.kind === 'settings') return 'gear';
	return 'journal';
}

/** A hidden document's mark's words: "Journal is hidden" for one hidden with the page that holds its collection (or the page it's under). */
export function hiddenTitle(doc: ListedDocument, documents: readonly ListedDocument[]): string {
	if (!doc.hiddenBy) return 'Hidden from the site';
	const by = documents.find((d) => d.collection === (doc.hiddenByCollection ?? doc.collection) && d.path === doc.hiddenBy);
	return by ? `${by.label} is hidden` : 'Hidden with the page it’s under';
}

export function DocRow(props: {
	doc: ListedDocument;
	crumb?: string;
	className?: string;
	style?: CSSProperties;
	/** After the meta: a bubbled mark for a closed parent. */
	extra?: ReactNode;
	/** Called after the document starts opening (the switcher closes itself). */
	onOpen?: () => void;
	/** The switcher's keyboard highlight. */
	active?: boolean;
	id?: string;
	/** Review gaps (Decision 3): before the icon, a manual collection's grip. */
	lead?: ReactNode;
	/** Review gaps (Decision 3): ⌥↑/⌥↓ on a manual collection's row. */
	onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
	/** The row's name for a screen reader, when it says more than the title ("Weekend bike shop, 2 of 7…"). */
	ariaLabel?: string;
}) {
	const editor = useEditor();
	const { doc } = props;
	const id = docId(doc);
	const current = useStore(editor.doc.state, (s) => docId(s.ref) === id);
	// The open document with a lockup too long for mobile says so in its row (the mockup's metaFor).
	const tooLong = useTooLong(current);
	const [why, setWhy] = useState(false);
	const collection = editor.site.collections.find((c) => c.name === doc.collection);
	const classes = ['drow', props.className, current ? 'is-current' : '', doc.warning ? 'is-warned' : '', props.active ? 'is-active' : ''].filter(Boolean).join(' ');
	const open = () => {
		if (doc.warning && !opensInEditor(doc)) {
			setWhy((w) => !w);
			editor.announce(`${doc.label} can't be opened. ${doc.warning.message}`);
			return;
		}
		void editor.openDocument({ collection: doc.collection, path: doc.path });
		props.onOpen?.();
	};
	return (
		<>
			<button
				type="button"
				id={props.id}
				className={classes}
				style={props.style}
				data-doc={id}
				aria-current={current ? 'page' : undefined}
				aria-expanded={doc.warning && !opensInEditor(doc) ? why : undefined}
				title={doc.warning?.message}
				aria-label={props.ariaLabel}
				onClick={open}
				onKeyDown={props.onKeyDown}
			>
				{props.lead}
				<Icon name={docIcon(collection)} />
				<span className="nm">
					{props.crumb ? <span className="crumb">{props.crumb} / </span> : null}
					{doc.label}
				</span>
				<span className="meta">
					{doc.warning ? (
						<span className="wmark" data-warning={doc.warning.code}>
							<Icon name="warn" size="xs" />
							<span className="sr">{warnedWords(doc)}</span>
						</span>
					) : null}
					{/* M9 Decision 7: hidden from the site (or under a hidden page). */}
					{doc.hidden ? (
						<span className="hmark" data-mark="hidden" title={hiddenTitle(doc, editor.documents.get())}>
							Hidden
						</span>
					) : null}
					{tooLong ? (
						<span className="wmark" title="Too long for mobile" data-mark="too-long">
							<Icon name="phone" size="xs" />
							<span className="sr">, too long for mobile</span>
						</span>
					) : null}
					{editor.mode === 'live' ? <DocMarksView file={doc.file} /> : <span data-slot="presence" hidden />}
					{props.extra}
				</span>
			</button>
			{doc.warning && why ? (
				<div className="note warn tight doc-why" role="note" data-why={id}>
					<Icon name="warn" />
					<div>
						<b>{doc.label} can't be opened</b>
						<p>{doc.warning.message}</p>
						<p className="mono">{doc.file}</p>
					</div>
				</div>
			) : null}
		</>
	);
}

/** Whether the open document (when `current`) has a lockup too long for mobile, as the preview measured it. */
export function useTooLong(current: boolean): boolean {
	const editor = useEditor();
	return useStore(editor.previewStatus, (s) => current && sameDoc(s.showing, editor.doc.get().ref) && s.warnings.some((w) => w.tooLong));
}
