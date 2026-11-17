/**
 * Reference (M5a Decision 6): the path of a document in collection `to`. The
 * picker (the mockup's `.lpop` with a find input) lists that collection's
 * documents by title, searched as the ⌘K switcher searches (nav/search.ts). A
 * reference to a document that doesn't exist is shown as missing, with a warning;
 * the page gets null for it.
 *
 * `RefRow` and `RefPicker` are the pieces a list of references uses too (ListField).
 */
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ReferenceField as ReferenceDescriptor } from '../../../fields.ts';
import { useEditor, useStore } from '../context.tsx';
import { docIcon } from '../nav/DocRow.tsx';
import { searchDocuments } from '../nav/search.ts';
import { Icon } from '../shell/Icons.tsx';
import { sameDoc, type ListedDocument } from '../../types.ts';
import { FieldFrame } from './FieldFrame.tsx';
import { useFieldWarnings, useHost } from './host.tsx';
import { Warnings } from './parts.tsx';

/** A collection's label, and its documents in listing order. */
export function useCollection(name: string): { label: string; icon: string; documents: ListedDocument[] } {
	const editor = useEditor();
	const documents = useStore(editor.documents);
	return useMemo(() => {
		const collection = editor.site.collections.find((c) => c.name === name);
		return {
			label: collection?.label ?? name,
			icon: docIcon(collection),
			documents: documents.filter((d) => d.collection === name),
		};
	}, [editor.site.collections, documents, name]);
}

/** One referenced document: its title and address, or "gone" when it doesn't exist. */
export function RefRow(props: {
	to: string;
	path: string;
	grip?: boolean;
	onRemove: () => void;
	removeLabel?: string;
	/** For a row that reorders by keys (a list of references): focusable, with its keys. */
	rowProps?: Record<string, unknown>;
	/** Extra classes on the row (a list of references' drag classes). */
	rowClass?: string;
	extra?: ReactNode;
}) {
	const { label, icon, documents } = useCollection(props.to);
	const doc = documents.find((d) => d.path === props.path);
	const remove = (
		<button type="button" className="ib" aria-label={props.removeLabel ?? `Remove ${doc ? doc.label || doc.title : 'the missing one'}`} onClick={props.onRemove}>
			<Icon name="x" size="sm" />
		</button>
	);
	const grip = props.grip ? (
		<span className="grip" aria-hidden="true">
			<Icon name="grip" />
		</span>
	) : null;
	const extra = props.rowClass ? ` ${props.rowClass}` : '';
	if (!doc) {
		return (
			<div className={`ref is-missing${extra}`} data-ref={props.path} {...props.rowProps}>
				{grip}
				<Icon name="warn" />
				<span className="t">
					<b>One that's gone</b>
					<small>
						{label} / {props.path} · skipped on the site
					</small>
				</span>
				{remove}
			</div>
		);
	}
	return (
		<div className={`ref${extra}`} data-ref={props.path} {...props.rowProps}>
			{grip}
			<Icon name={icon} />
			<span className="t">
				<b>{doc.label || doc.title}</b>
				<small>{doc.url ?? doc.path}</small>
			</span>
			{props.extra}
			{remove}
		</div>
	);
}

/** The picker: the collection's documents by title, filtered by what's typed. `taken` are shown as added. */
export function RefPicker(props: { to: string; taken?: readonly string[]; onPick: (path: string) => void; onClose: () => void }) {
	const editor = useEditor();
	const all = useStore(editor.documents);
	const open = useStore(editor.doc.state, (s) => s.ref);
	const { label, icon } = useCollection(props.to);
	const [query, setQuery] = useState('');
	const hits = useMemo(() => {
		const collection = editor.site.collections.filter((c) => c.name === props.to);
		const docs = all.filter((d) => d.collection === props.to && !sameDoc(d, open));
		if (!query.trim()) return docs;
		return searchDocuments(query, docs, collection).flatMap((g) => g.hits.map((h) => h.doc));
	}, [all, editor.site.collections, open, props.to, query]);
	const shown = hits.slice(0, 6);
	const taken = new Set(props.taken ?? []);
	const first = shown.find((d) => !taken.has(d.path));
	const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			if (first) props.onPick(first.path);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			props.onClose();
		}
	};
	return (
		<div className="lpop" role="dialog" aria-label={`Choose from ${label}`}>
			<div className="find">
				<Icon name="search" />
				<input
					className="input"
					value={query}
					placeholder={`Find in ${label}`}
					aria-label={`Find in ${label}`}
					autoComplete="off"
					spellCheck={false}
					autoFocus
					data-ref-find=""
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={onKey}
					onBlur={(e) => {
						if (!e.relatedTarget || !(e.currentTarget.closest('.lpop')?.contains(e.relatedTarget as Node) ?? false)) props.onClose();
					}}
				/>
			</div>
			<div className="lpop-list">
				{shown.map((d) => {
					const on = taken.has(d.path);
					return (
						<button
							key={d.path}
							type="button"
							className={`drow${d === first ? ' is-active' : ''}`}
							data-path-pick={d.path}
							disabled={on}
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => props.onPick(d.path)}
						>
							<Icon name={icon} />
							<span className="nm">{d.label || d.title}</span>
							<span className="meta">
								{/* M9 Decision 7: a hidden page is still offered (the reference is legitimate), marked as the pages list marks it. */}
								{d.hidden ? (
									<span className="hmark" data-mark="hidden" title={d.hiddenBy ? 'Hidden from the site with the page it’s under' : 'Hidden from the site'}>
										Hidden
									</span>
								) : null}
								<span>{on ? 'Added' : <span className="mono">{d.url ?? d.path}</span>}</span>
							</span>
						</button>
					);
				})}
				{shown.length === 0 ? <div className="sw-more">{query.trim() ? `Nothing in ${label} called “${query.trim()}”.` : `${label} has nothing in it yet.`}</div> : null}
				{hits.length > shown.length ? <div className="sw-more">{hits.length - shown.length} more: keep typing</div> : null}
			</div>
		</div>
	);
}

export function ReferenceField(props: { name: string; label: string; field: ReferenceDescriptor; value: unknown }) {
	const host = useHost();
	const { label: collectionLabel } = useCollection(props.field.to);
	const [picking, setPicking] = useState(false);
	const value = typeof props.value === 'string' && props.value !== '' ? props.value : null;
	const warnings = useFieldWarnings(props.name, props.field, props.value);
	const choose = (
		<div className="lnk" style={{ marginTop: value ? 'var(--space-2)' : 0 }}>
			<button
				type="button"
				className="linkbtn subtle"
				data-path={props.name}
				aria-expanded={picking}
				// While the picker is open, keep focus in its find input so this click closes it (and doesn't blur-close, then reopen).
				onMouseDown={(e) => picking && e.preventDefault()}
				onClick={() => setPicking(!picking)}
			>
				<Icon name={value ? 'search' : 'plus'} size="xs" />
				{value ? 'Choose another' : `Choose from ${collectionLabel}`}
			</button>
			{picking ? (
				<RefPicker
					to={props.field.to}
					taken={value ? [value] : []}
					onPick={(path) => {
						host.set(props.name, path);
						setPicking(false);
					}}
					onClose={() => setPicking(false)}
				/>
			) : null}
		</div>
	);
	return (
		<FieldFrame blockKey={host.scope} name={props.name} label={props.label} help={props.field.help} labelId={`f-${host.scope}-${props.name}-l`}>
			{value ? <RefRow to={props.field.to} path={value} onRemove={() => host.set(props.name, null)} /> : <div className="list-empty">None chosen.</div>}
			<Warnings warnings={warnings} />
			{choose}
		</FieldFrame>
	);
}
