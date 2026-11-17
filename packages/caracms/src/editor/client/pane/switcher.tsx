/**
 * The ⌘K document switcher (the mockup's #switcher and #switcher-find): a popover
 * over the bar that opens upward, **searching every document's title and address,
 * collections included, grouped by collection** (Decision 9; client/nav/search.ts).
 *
 * Unfiltered it lists Recent (this browser's, from the cookie), every page in tree
 * order, then the first few of each other collection, then (M5a) Shared blocks and Site
 * Settings. Typing filters; ↑/↓ move the
 * highlight, Enter opens it, Esc closes (App.tsx). The bar's trigger and ⌘K open it
 * (`editor.setPop('switcher')`); Popovers.tsx renders it while `view.pop === 'switcher'`.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { Icon } from '../shell/Icons.tsx';
import { DocRow } from '../nav/DocRow.tsx';
import { parentLabel, searchDocuments } from '../nav/search.ts';
import { docId, opensInEditor, type ListedDocument } from '../../types.ts';

export const SWITCHER_READY = true;

/** How many of a flat collection the unfiltered list shows before "N more: type to find one". */
const FIRST = 5;
const MAX_HITS = 12;

interface Section {
	key: string;
	heading: string;
	items: { doc: ListedDocument; crumb: string }[];
	more: string | null;
}

export function Switcher() {
	const editor = useEditor();
	const documents = useStore(editor.documents);
	const recent = useStore(editor.ui, (u) => u.recent);
	const [query, setQuery] = useState('');
	const [active, setActive] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const pop = useRef<HTMLDivElement>(null);

	const sections = useMemo<Section[]>(() => {
		const crumbOf = (d: ListedDocument) => (editor.site.collections.find((c) => c.name === d.collection)?.nested ? parentLabel(d, documents) : '');
		if (query.trim()) {
			return searchDocuments(query, documents, editor.site.collections).map((g) => ({
				key: g.collection.name,
				heading: `${g.collection.label} · ${g.collection.nested || g.hits.length === g.total ? g.hits.length : `${g.hits.length} of ${g.total}`}`,
				items: g.hits.slice(0, MAX_HITS),
				more: g.hits.length > MAX_HITS ? `${g.hits.length - MAX_HITS} more: keep typing` : null,
			}));
		}
		const out: Section[] = [];
		const recentDocs = recent
			.map((id) => documents.find((d) => docId(d) === id))
			.filter((d): d is ListedDocument => !!d && opensInEditor(d))
			.slice(0, 3);
		if (recentDocs.length) out.push({ key: 'recent', heading: 'Recent', items: recentDocs.map((d) => ({ doc: d, crumb: crumbOf(d) })), more: null });
		for (const c of editor.site.collections) {
			const docs = documents.filter((d) => d.collection === c.name);
			if (!docs.length) continue;
			const shown = c.nested ? docs : docs.slice(0, FIRST);
			// Shared blocks and Site Settings (M5a) are named without a count, as the mockup has them.
			const reserved = c.kind === 'shared' || c.kind === 'settings';
			out.push({
				key: c.name,
				heading: c.nested || reserved ? c.label : `${c.label} · ${docs.length}`,
				items: shown.map((d) => ({ doc: d, crumb: crumbOf(d) })),
				more: docs.length > shown.length ? `${docs.length - shown.length} more: type to find one` : null,
			});
		}
		return out;
	}, [query, documents, recent, editor.site.collections]);

	const flat = sections.flatMap((s) => s.items);
	const activeIndex = flat.length ? Math.min(active, flat.length - 1) : -1;

	useEffect(() => {
		input.current?.focus();
	}, []);
	useEffect(() => setActive(0), [query]);
	// Keep the highlight in view.
	useEffect(() => {
		pop.current?.querySelector('.drow.is-active')?.scrollIntoView({ block: 'nearest' });
	}, [activeIndex]);
	// A click outside closes it (the bar's trigger toggles it itself).
	useEffect(() => {
		const onDown = (event: MouseEvent) => {
			const target = event.target as Element | null;
			if (!target || pop.current?.contains(target) || target.closest?.('.docbtn')) return;
			editor.setPop(null);
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [editor]);

	const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (!flat.length) return;
			const step = event.key === 'ArrowDown' ? 1 : -1;
			setActive((activeIndex + step + flat.length) % flat.length);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const hit = flat[activeIndex];
			if (!hit) return;
			if (!opensInEditor(hit.doc)) {
				editor.announce(`${hit.doc.label} can't be opened. ${hit.doc.warning?.message ?? ''}`);
				return;
			}
			editor.setPop(null);
			void editor.openDocument({ collection: hit.doc.collection, path: hit.doc.path });
		}
	};

	let n = -1;
	return (
		<div
			ref={pop}
			className="pop switcher"
			role="dialog"
			aria-label="Go to a document"
			style={{ left: 8, width: 380, height: 'min(540px, calc(100% - var(--bar-h) - 24px))' }}
		>
			<div className="sw-in">
				<Icon name="search" />
				<input
					ref={input}
					id="swq"
					placeholder="Go to a document"
					aria-label="Go to a document"
					aria-controls="swlist"
					aria-activedescendant={activeIndex >= 0 ? `sw-${activeIndex}` : undefined}
					autoComplete="off"
					spellCheck={false}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={onKey}
				/>
				<kbd>esc</kbd>
			</div>
			<div className="sw-list" id="swlist">
				{sections.length === 0 ? <div className="sw-more">Nothing called “{query.trim()}”.</div> : null}
				{sections.map((s) => (
					<div key={s.key} role="group" aria-label={s.heading} data-sw-group={s.key}>
						<div className="sw-h">{s.heading}</div>
						{s.items.map((item) => {
							n += 1;
							const i = n;
							return (
								<DocRow
									key={`${s.key}:${docId(item.doc)}`}
									id={`sw-${i}`}
									doc={item.doc}
									crumb={item.crumb}
									active={i === activeIndex}
									onOpen={() => editor.setPop(null)}
								/>
							);
						})}
						{s.more ? <div className="sw-more">{s.more}</div> : null}
					</div>
				))}
			</div>
		</div>
	);
}
