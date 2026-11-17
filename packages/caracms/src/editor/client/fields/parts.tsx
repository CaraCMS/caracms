/**
 * Pieces M5a's fields share: the amber field message (`.field-warn`, for messages
 * that block nothing), the few icons the shell's sprite doesn't have yet, and the
 * document list a link picks from (Decision 4: the site's documents by title and
 * address; picking one stores its URL).
 */
import { Fragment, useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { fileAddress, fileKeyOf, fileTypeOf } from '../../../files.ts';
import { validateLink } from '../../../links.ts';
import { fileSize, mediaFor } from '../media/store.ts';
import type { FieldWarning } from '../../../fields.ts';
import { useEditor, useStore } from '../context.tsx';
import { docIcon } from '../nav/DocRow.tsx';
import { parentLabel, searchDocuments } from '../nav/search.ts';
import { Icon } from '../shell/Icons.tsx';
import type { LibraryFile, ListedDocument } from '../../types.ts';
import type { Editor } from '../editor.ts';

/**
 * Icons the mockup's sprite has and the shell's doesn't yet (shell/Icons.tsx is
 * another phase's file): the same paths, drawn inline with the sprite's classes.
 */
const EXTRA: Record<string, ReactNode> = {
	link: <path d="M6.5 4.5H5a3.5 3.5 0 0 0 0 7h1.5M9.5 4.5H11a3.5 3.5 0 0 1 0 7H9.5M5.5 8h5" />,
	// M6c G4: a file, and Replace's swap (kept here, not in the shell's sprite, beside the grid's own icons).
	file: <path d="M4 1.5h5.5L12.5 4.5v10H4zM9.5 1.5v3h3M6 8.5h4M6 11h4" />,
	swap: <path d="M3 5h9.5M10 2.5 12.5 5 10 7.5M13 11H3.5M6 8.5 3.5 11 6 13.5" />,
	ul: (
		<>
			<path d="M6 4h8M6 8h8M6 12h8" />
			<g fill="currentColor" stroke="none">
				<circle cx="2.8" cy="4" r="1" />
				<circle cx="2.8" cy="8" r="1" />
				<circle cx="2.8" cy="12" r="1" />
			</g>
		</>
	),
	ol: <path d="M6.5 4h7.5M6.5 8h7.5M6.5 12h7.5M2.5 2.8l1-.6v3.3M2.2 7.2a.9.9 0 0 1 1.6.5c0 .7-1.6 1.4-1.6 2.1h1.7M2.2 11h1.5l-.8 1 .1 0a.8.8 0 1 1-.8 1" />,
	calendar: (
		<>
			<rect x="2" y="3" width="12" height="11" rx="1.5" />
			<path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
		</>
	),
};

/** `<Icon>`, or one of the extra icons above. */
export function FieldIcon({ name, size }: { name: string; size?: 'sm' | 'xs' }) {
	const extra = EXTRA[name];
	if (!extra) return <Icon name={name} size={size} />;
	return (
		<svg className={size ? `i i-${size}` : 'i'} viewBox="0 0 16 16" aria-hidden="true">
			{extra}
		</svg>
	);
}

/** Field messages that block nothing (amber; M5a Decision 15: kept as typed, flagged on the field). */
export function Warn({ children, quiet, id }: { children: ReactNode; quiet?: boolean; id?: string }) {
	return (
		<p className={`field-warn${quiet ? ' quiet' : ''}`} id={id} role="status">
			<Icon name="warn" size="sm" />
			<span>{children}</span>
		</p>
	);
}

/** One `.field-warn` per warning (deduplicated by message). */
export function Warnings({ warnings, id, quiet }: { warnings: readonly FieldWarning[]; id?: string; quiet?: boolean }) {
	const messages = [...new Set(warnings.map((w) => w.message))];
	if (messages.length === 0) return null;
	return (
		<>
			{messages.map((m, i) => (
				<Warn key={m} id={i === 0 ? id : undefined} quiet={quiet}>
					{m}
				</Warn>
			))}
		</>
	);
}

/** Documents with an address, the only ones a link can point at (shared blocks and Site Settings have none). */
export function useLinkable(): ListedDocument[] {
	const editor = useEditor();
	const documents = useStore(editor.documents);
	return useMemo(() => documents.filter((d) => typeof d.url === 'string'), [documents]);
}

export { documentAt } from '../preview/link-target.ts';

/** Does what's typed look like an address rather than a document's name? (The mockup's looksLikeAddr.) */
export const looksLikeAddress = (q: string) => /^(\/|#|https?:|mailto:|tel:|www\.)/i.test(q.trim()) || /\S\.\S/.test(q.trim()) || /@/.test(q);

export interface LinkHit {
	key: string;
	href: string;
	/** A document's title (with its parent's), or null for "Link to <address>". */
	doc: ListedDocument | null;
	crumb: string;
}

export interface LinkHits {
	groups: { label: string; hits: LinkHit[]; more: number }[];
	address: LinkHit | null;
}

/**
 * What the link popover lists for a query: the address itself when it looks like one,
 * then documents, grouped by collection. No React: the sidebar's popover (useLinkHits)
 * and the page's (on-page rich text, overlays/rich-text-bar.ts) list the same.
 */
export function linkHits(query: string, documents: readonly ListedDocument[], collections: Editor['site']['collections']): LinkHits {
	const q = query.trim();
	const address: LinkHit | null = q && looksLikeAddress(q) ? { key: `addr:${q}`, href: q, doc: null, crumb: '' } : null;
	// M9 Decision 7: a hidden page isn't offered (a link to one only warns).
	const linkable = documents.filter((d) => typeof d.url === 'string' && !d.hidden);
	const groups = q
		? searchDocuments(q, linkable, collections).map((g) => ({
				label: g.collection.label,
				hits: g.hits.slice(0, 5).map((h) => ({ key: `${h.doc.collection}/${h.doc.path}`, href: h.doc.url!, doc: h.doc, crumb: h.crumb })),
				more: Math.max(0, g.hits.length - 5),
			}))
		: collections
				.map((c) => {
					const docs = linkable.filter((d) => d.collection === c.name);
					return {
						label: c.label,
						hits: docs.slice(0, 4).map((d) => ({ key: `${d.collection}/${d.path}`, href: d.url!, doc: d, crumb: c.nested ? parentLabel(d, documents) : '' })),
						more: Math.max(0, docs.length - 4),
					};
				})
				.filter((g) => g.hits.length > 0);
	return { groups, address };
}

/** linkHits for the sidebar's popover, from the editor's document listing. */
export function useLinkHits(query: string): LinkHits {
	const editor = useEditor();
	const documents = useStore(editor.documents);
	return useMemo(() => linkHits(query, documents, editor.site.collections), [query, documents, editor.site.collections]);
}

/** The hit Enter picks: the typed address, else the first document listed. */
export const firstHit = (hits: LinkHits): LinkHit | null => hits.address ?? hits.groups[0]?.hits[0] ?? null;

/**
 * The list a link picks from (the mockup's `.lpop`): an optional find input, the
 * typed address ("Link to …", with the link rule's message when it fails), and
 * the site's documents by title and address. `onPick` gets the URL to store.
 */
export function LinkPopover(props: {
	query: string;
	onQuery?: (q: string) => void;
	onPick: (href: string) => void;
	onClose: () => void;
	/** The find input, for rich text's popover; a link field types into its own box instead. */
	withFind?: boolean;
	/** A "Remove link" row, for rich text's popover over an existing link. */
	onRemove?: () => void;
	/** Focus leaving the popover (rich text closes it when focus goes outside the field). */
	onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
	/**
	 * M6c G4 (Decision 7): rich text's File…, beside the find input. The library's files
	 * list in the popover (finding by name, Upload… too); picking one calls `onPickFile`.
	 * A link to a file (`query` is its address, `editing`) shows the file, and for a PDF
	 * New tab / Download (`onPick` with the new address).
	 */
	onPickFile?: (file: LibraryFile) => void;
}) {
	const editor = useEditor();
	const icon = (doc: ListedDocument | null) => docIcon(editor.site.collections.find((c) => c.name === doc?.collection));
	const [filesMode, setFilesMode] = useState(false);
	const choosing = useRef(false);
	const linked = props.onPickFile ? fileKeyOf(props.query.trim()) : null;
	const { groups, address } = useLinkHits(linked || filesMode ? '' : props.query);
	const blur = (event: FocusEvent<HTMLDivElement>) => {
		// The browser's file dialog takes focus from the page: the popover stays for the file.
		if (choosing.current) return;
		props.onBlur?.(event);
	};
	if (props.onPickFile && (filesMode || linked)) {
		return (
			<div className="lpop" role="dialog" aria-label="Where the link goes" onBlur={blur} data-lpop-files="">
				{linked && !filesMode ? (
					<LinkedFile href={props.query} onPick={props.onPick} onRemove={props.onRemove} onChange={() => setFilesMode(true)} onClose={props.onClose} />
				) : (
					<FilesInPopover
						choosing={choosing}
						onPick={(file) => {
							setFilesMode(false);
							props.onPickFile!(file);
						}}
						onBack={() => (linked ? setFilesMode(false) : (setFilesMode(false), props.onQuery?.('')))} onClose={props.onClose} />
				)}
			</div>
		);
	}
	const rule = address ? validateLink(address.href) : undefined;
	const first = address ?? groups[0]?.hits[0] ?? null;
	const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			if (first) props.onPick(first.href);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			props.onClose();
		}
	};
	return (
		<div className="lpop" role="dialog" aria-label="Where the link goes" onBlur={blur}>
			{props.withFind ? (
				<div className={props.onPickFile ? 'top' : undefined}>
					<div className="find">
						<Icon name="search" />
						<input
							className="input"
							value={props.query}
							placeholder="Find a page, or type an address"
							aria-label="Find a page, or type an address"
							autoComplete="off"
							spellCheck={false}
							autoFocus
							data-link-find=""
							onChange={(e) => props.onQuery?.(e.target.value)}
							onKeyDown={onKey}
						/>
					</div>
					{props.onPickFile ? (
						<button type="button" className="btn" data-act="link-file" title="Link to a file in the library" onMouseDown={(e) => e.preventDefault()} onClick={() => setFilesMode(true)}>
							<FieldIcon name="file" size="sm" />
							File…
						</button>
					) : null}
				</div>
			) : null}
			<div className="lpop-list">
				{address ? (
					<button type="button" className="drow is-active" data-href={address.href} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onPick(address.href)}>
						<Icon name={address.href.startsWith('mailto:') ? 'mail' : address.href.startsWith('/') ? 'page' : 'ext'} />
						<span className="nm">
							Link to <span className="mono">{address.href}</span>
						</span>
					</button>
				) : null}
				{rule ? <Warn>{rule}</Warn> : null}
				{groups.map((g) => (
					<Fragment key={g.label}>
						<div className="sw-h">{g.label}</div>
						{g.hits.map((h) => (
							<button
								key={h.key}
								type="button"
								className={`drow${!address && h === groups[0]!.hits[0] ? ' is-active' : ''}`}
								data-href={h.href}
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => props.onPick(h.href)}
							>
								<Icon name={icon(h.doc)} />
								<span className="nm">
									{h.crumb ? <span className="crumb">{h.crumb} / </span> : null}
									{h.doc?.label || h.doc?.title}
								</span>
								<span className="meta">
									<span className="mono">{h.href}</span>
								</span>
							</button>
						))}
						{g.more > 0 ? <div className="sw-more">{g.more} more: keep typing</div> : null}
					</Fragment>
				))}
				{!address && groups.length === 0 ? <div className="sw-more">No page called “{props.query.trim()}”.</div> : null}
				{props.onRemove ? (
					<button type="button" className="drow" onMouseDown={(e) => e.preventDefault()} onClick={props.onRemove}>
						<Icon name="x" />
						<span className="nm">Remove link</span>
					</button>
				) : null}
			</div>
			<div className="lpop-foot">Or type an address.</div>
		</div>
	);
}

/** M6c G4: the type tile, small (the mockup's .ftype.sm). */
const Tile = () => <span className="ftype sm" aria-hidden="true" />;

/** A rich-text link to a file, in its popover (the mockup's #rt-link-file): the file, then how it opens. */
function LinkedFile(props: { href: string; onPick: (href: string) => void; onRemove?: () => void; onChange: () => void; onClose: () => void }) {
	const editor = useEditor();
	const files = useStore(mediaFor(editor).files, (l) => l.list);
	const file = fileKeyOf(props.href.trim())!;
	const entry = files?.find((f) => f.key === file.key);
	const type = fileTypeOf(file.key)!;
	const name = entry?.name ?? file.key.slice(file.key.lastIndexOf('/') + 1);
	const missing = !!files && !entry;
	const hash = props.href.indexOf('#');
	const to = (download: boolean) => `${fileAddress(file.key, { download })}${hash === -1 ? '' : props.href.slice(hash)}`;
	// Focus stays in the popover (the search it replaced is gone), so it doesn't close.
	const first = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!first.current?.closest('.lpop')?.contains(document.activeElement)) first.current?.focus({ preventScroll: true });
	}, []);
	return (
		<>
			<div className="top">
				<button ref={first} type="button" className="btn" data-act="link-file" title="Link to another file" onMouseDown={(e) => e.preventDefault()} onClick={props.onChange}>
					<FieldIcon name="file" size="sm" />
					File…
				</button>
			</div>
			<div className="picked" data-picked-file={file.key}>
				{missing ? <Icon name="warn" /> : <Tile />}
				<span className="ft">
					<b>{name}</b>
					<small>{missing ? "isn't in the library" : `${type.label}${entry?.bytes != null ? ` · ${fileSize(entry.bytes)}` : ''}`}</small>
				</span>
				{props.onRemove ? (
					<button type="button" className="ib" aria-label="Remove the link" onMouseDown={(e) => e.preventDefault()} onClick={props.onRemove}>
						<Icon name="x" size="sm" />
					</button>
				) : null}
			</div>
			{type.opensInTab && !missing ? (
				<div className="opens">
					<span className="lbl">When clicked</span>
					<div className="mini-seg" role="radiogroup" aria-label="When clicked">
						<button type="button" role="radio" aria-checked={!file.download} data-opens="tab" onMouseDown={(e) => e.preventDefault()} onClick={() => props.onPick(to(false))}>
							<Icon name="ext" />
							New tab
						</button>
						<button type="button" role="radio" aria-checked={file.download} data-opens="download" onMouseDown={(e) => e.preventDefault()} onClick={() => props.onPick(to(true))}>
							<Icon name="download" />
							Download
						</button>
					</div>
				</div>
			) : null}
			{missing ? (
				<div className="lpop-foot">This link goes nowhere until it points at a file in the library.</div>
			) : !type.opensInTab ? (
				<div className="lpop-foot">A {type.label} file doesn’t open in the browser: on the site, clicking it saves the file.</div>
			) : null}
		</>
	);
}

/** File… in rich text's popover: the library's files, found by name, with Upload… (a link takes files only). */
function FilesInPopover(props: { choosing: { current: boolean }; onPick: (file: LibraryFile) => void; onBack: () => void; onClose: () => void }) {
	const editor = useEditor();
	const media = mediaFor(editor);
	const files = useStore(media.files);
	const uploads = useStore(media.uploads);
	const [find, setFind] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [tag, setTag] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (media.files.get().list === null && !media.files.get().unset) void media.loadImages();
	}, [media]);
	const q = find.trim().toLowerCase();
	const list = (files.list ?? []).filter((f) => !q || f.name.toLowerCase().includes(q));
	const up = tag ? uploads.find((u) => u.id === tag) : null;
	const take = async (file: File) => {
		setError(null);
		const id = `rt-file-${Date.now()}`;
		setTag(id);
		const sent = await media.uploadFile(file, id);
		setTag(null);
		if (sent.ok) props.onPick(sent.file);
		else if (sent.error) setError(sent.error);
	};
	return (
		<>
			<div className="top">
				<div className="find">
					<Icon name="search" />
					<input
						className="input"
						value={find}
						placeholder="Find a file"
						aria-label="Find a file"
						autoComplete="off"
						spellCheck={false}
						autoFocus
						data-file-find=""
						onChange={(e) => setFind(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && list[0]) {
								e.preventDefault();
								props.onPick(list[0]);
							} else if (e.key === 'Escape') {
								e.preventDefault();
								props.onClose();
							}
						}}
					/>
				</div>
				<button
					type="button"
					className="btn"
					data-act="lib-upload"
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => {
						props.choosing.current = true;
						// Back from the browser's file dialog (a file chosen or not): blurs count again.
						window.addEventListener('focus', () => setTimeout(() => (props.choosing.current = false), 400), { once: true });
						input.current?.click();
					}}
				>
					<Icon name="upload" size="sm" />
					Upload…
				</button>
				<input
					ref={input}
					type="file"
					hidden
					accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.zip"
					data-rt-file=""
					onChange={(e) => {
						props.choosing.current = false;
						const file = e.target.files?.[0];
						e.target.value = '';
						if (file) void take(file);
					}}
				/>
			</div>
			<div className="lpop-list">
				<div className="sw-h">Files</div>
				{up ? (
					<div className="drow" role="status" aria-label={`${up.name}, uploading, ${up.pct}%`}>
						<Tile />
						<span className="nm">{up.name}</span>
						<span className="meta">Uploading · {up.pct}%</span>
					</div>
				) : null}
				{error ? <Warn>{error}</Warn> : null}
				{files.unset ? <div className="sw-more">{files.unset.error}</div> : null}
				{list.slice(0, 8).map((f, i) => (
					<button key={f.key} type="button" className={`drow${i === 0 && q ? ' is-active' : ''}`} data-file={f.key} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onPick(f)}>
						<Tile />
						<span className="nm">{f.name}</span>
						<span className="meta">
							{f.type}
							{f.bytes !== null ? ` · ${fileSize(f.bytes)}` : ''}
						</span>
					</button>
				))}
				{list.length > 8 ? <div className="sw-more">{list.length - 8} more: keep typing</div> : null}
				{files.list && list.length === 0 ? <div className="sw-more">{q ? `No file called “${find.trim()}”.` : 'No files yet.'}</div> : null}
				<button type="button" className="drow" onMouseDown={(e) => e.preventDefault()} onClick={props.onBack}>
					<Icon name="chev-l" />
					<span className="nm">Back to pages</span>
				</button>
			</div>
		</>
	);
}
