/**
 * The document levels of M5a's new kinds of document, each a form beside its preview
 * (no block list): the document store holds each as one block (document-store.ts →
 * formKey), so every field is mounted through a field host on that key, with Undo,
 * the keeper and the write path as for a block.
 *
 * - **A list-of-fields document** (`FieldsDocumentLevel`; the mockup's #case, Decision
 *   7): its collection stacked above, its kind, New and read-only chips on the head's sub line
 *   (the prev/next stepper went in the pre-M7 polish), then `title`
 *   (one line, always first), then the collection's fields in schema order. Click to
 *   edit from its preview opens a field here (Decision 13, nested paths too).
 * - **A shared block as its own document** (`SharedDocumentLevel`; #shared-doc,
 *   Decision 8): where it's used, each a link, then its block's fields. Its preview is
 *   the block on its own in the site's page frame. Edit in context (Decisions 1–4): a slot's
 *   block names a few of the pages it fills and "N more", has its "Default <slot>" switch
 *   above its fields, and says what it also shows from Site Settings under them.
 * - **Site Settings** (`SettingsLevel`; #settings, #settings-public, #settings-self,
 *   Decision 10): edit in context, Decision 4, the site's own settings first; then who can
 *   sign in (the whitelist's rules checked as you type, the agency line, removing yourself
 *   asks first), the editor's name and accent, with the logo and the tab icon (M5b
 *   Decision 11, #settings-brand: image-only media slots with no alt and no focal point).
 *   No page of its own: it shows over the last page, undimmed (edit in context, Decision 9).
 *
 * M6: the case study's "SEO" group ends its form (fields/SeoGroup.tsx), and
 * Site Settings gains its defaults, the Google tag and Form emails (settings-m6.tsx).
 */
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { presetOf } from '../../accent-presets.ts';
import { media as mediaField, titleCase, type Field, type Fields } from '../../../../fields.ts';
import { parseMedia } from '../../../../media-value.ts';
import { parseAllowEntry } from '../../../../live/auth/allow-rules.ts';
import { useEditor, useStore } from '../../context.tsx';
import type { Editor } from '../../editor.ts';
import { DocMenu, TitleNote } from '../../documents/DocMenu.tsx';
import { FieldControl } from '../../fields/FieldControl.tsx';
import { FieldFrame } from '../../fields/FieldFrame.tsx';
import { Warn } from '../../fields/parts.tsx';
import { NO_TITLE } from '../../../../document-problems.ts';
import { FieldHostProvider, parseBase, type FieldHost } from '../../fields/host.tsx';
import { MediaSlot } from '../../fields/MediaField.tsx';
import { mediaFor } from '../../media/store.ts';
import { DocNotices, ReadOnlyChip } from '../../live/notices.tsx';
import { Icon } from '../../shell/Icons.tsx';
import { BrandMark } from '../../shell/Brand.tsx';
import { formKey } from '../../state/document-store.ts';
import { formFields } from '../../state/schema.ts';
import { docId, type ListedDocument } from '../../../types.ts';
import { CurrentHead, DocumentsTab, GlobalNotes, LevelTab, OverPageTab, RecentStrip, Trail, useOverBack, useOverPage } from '../parts.tsx';
import { singular } from '../../documents/actions.ts';
import { SeoGroup } from '../../fields/SeoGroup.tsx';
import { SettingsM6 } from './SettingsM6.tsx';
import { BlockHelp, StatesLine } from './BlockLevel.tsx';
import { DefaultSwitch } from '../../fields/DefaultSwitch.tsx';
import { FramePickers } from '../../fields/FramePickers.tsx';
import { AlsoShows, ReadRows } from '../FromPage.tsx';

/** The form's host: the document's one block, its fields picked at the document level. */
export function formHost(editor: Editor, key: string, raw: Record<string, unknown> | undefined, readOnly: boolean): FieldHost {
	return {
		scope: key,
		picked: (view) => (view.level === 'document' ? view.field : null),
		pick(path) {
			const view = editor.view.get();
			if (view.field !== path || view.block !== key) editor.view.update({ field: path, picked: false, block: key });
		},
		set: (path, value, options) => editor.doc.setField(key, path, value, options),
		removeItem(path, index, label) {
			editor.doc.removeItem(key, path, index, { label });
			editor.announce(`${label}. Undo with Command Z.`);
		},
		raw: (name) => (raw && Object.hasOwn(raw, name) ? raw[name] : undefined),
		readOnly,
	};
}

const asObject = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** Live mode: a fieldset disabled while the document is read-only (M4 Decision 9). Local mode: no wrapper. */
function FormFields({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
	const editor = useEditor();
	if (editor.mode !== 'live') return <div data-form="">{children}</div>;
	return (
		<fieldset className="ro-fields" data-form="" disabled={readOnly} data-read-only={readOnly ? '' : undefined}>
			{children}
		</fieldset>
	);
}

/** The "New" chip for a document that isn't on `main` yet (live mode's waiting list says so). */
function useIsNew(): boolean {
	const editor = useEditor();
	const ref = useStore(editor.doc.state, (s) => s.ref);
	return useStore(editor.liveState, (s) => (s.status?.waiting ?? []).some((w) => w.collection === ref.collection && w.path === ref.path && w.change === 'new' && !w.movedFrom));
}

/** The collection's level tab, stacked above a document of it. */
export function CollectionTab({ name }: { name: string }) {
	const editor = useEditor();
	const collection = editor.site.collections.find((c) => c.name === name);
	const count = useStore(editor.documents, (d) => d.filter((x) => x.collection === name).length);
	if (!collection) return null;
	if (collection.kind === 'shared') {
		return (
			<button type="button" className="lv" onClick={() => editor.openCollection(name)}>
				<b>{collection.label}</b>
				<span className="n">{count}</span>
			</button>
		);
	}
	return <LevelTab name={collection.label} kind="Collection" count={String(count)} onClick={() => editor.openCollection(name)} />;
}

/**
 * Editor wording note (caracms-cloud adversarial review): beside a heading (a lockup field),
 * the title says where it shows, so the two aren't mistaken for each other. The document's
 * title is its name in the site's lists and links, and the browser tab's and search
 * results' title unless its SEO title says otherwise (head.ts).
 */
export const TITLE_BESIDE_HEADING = 'Shown in lists, links, browser tabs and search results.';

/**
 * The title field every fields document has first (Decision 7): one line, always there.
 * Blank, it says so (caracms-cloud adversarial review, finding 15), as typed: the edit is
 * kept all the same, and Publish leaves the document waiting until it has one.
 */
function TitleField({ scope, help }: { scope: string; help?: string }) {
	const editor = useEditor();
	const title = useStore(editor.doc.state, (s) => s.document.title);
	const id = `f-${scope}-title`;
	const blank = title.trim() === '';
	return (
		<FieldFrame blockKey={scope} name="title" label="Title" htmlFor={id} help={help}>
			<input
				className="input"
				id={id}
				data-path="title"
				value={title}
				autoComplete="off"
				spellCheck={false}
				aria-invalid={blank || undefined}
				aria-describedby={blank ? `${id}-problem` : undefined}
				onChange={(e) => editor.doc.setTitle(e.target.value.replace(/\n+/g, ' '))}
			/>
			{blank ? <Warn id={`${id}-problem`}>{NO_TITLE.note}</Warn> : null}
		</FieldFrame>
	);
}

function useFormHost(): { host: FieldHost | null; data: Record<string, unknown>; key: string | null; readOnly: boolean; raw: Record<string, unknown> | undefined } {
	const editor = useEditor();
	const session = useStore(editor.doc.state);
	const readOnly = useStore(editor.access, (a) => a.readOnly);
	const key = formKey(session);
	const kind = session.document.kind;
	const base = parseBase(session.base);
	const raw = kind === 'shared' ? asObject(asObject(base)?.block) : asObject(base);
	const host = useMemo(() => (key ? formHost(editor, key, raw, readOnly) : null), [editor, key, raw, readOnly]);
	return { host, data: session.document.blocks[0]?.data ?? {}, key, readOnly, raw };
}

// ── A list-of-fields document ────────────────────────────────────────────────

/** The field kinds small enough to sit two to a row (the mockup's #case: Sector beside Featured). */
const COMPACT = new Set<Field['kind']>(['select', 'toggle', 'number']);

/** The form's rows: each field on its own, except two compact fields in a row, which share one (`.two`). */
export function formRows(fields: Fields): [string, Field][][] {
	const rows: [string, Field][][] = [];
	const entries = Object.entries(fields);
	for (let i = 0; i < entries.length; i++) {
		const here = entries[i]!;
		const next = entries[i + 1];
		if (next && COMPACT.has(here[1].kind) && COMPACT.has(next[1].kind)) {
			rows.push([here, next]);
			i++;
		} else rows.push([here]);
	}
	return rows;
}

export function FieldsDocumentLevel() {
	const editor = useEditor();
	const ref = useStore(editor.doc.state, (s) => s.ref);
	const entry = useStore(editor.doc.state, (s) => s.entry);
	const title = useStore(editor.doc.state, (s) => s.document.title || s.entry.label);
	const isNew = useIsNew();
	const { host, data, key, readOnly } = useFormHost();
	const over = useOverPage();
	const overBack = useOverBack();
	const collection = editor.site.collections.find((c) => c.name === ref.collection);
	if (!collection || !host || !key) return null;
	const fields: Fields = formFields(editor.site, collection.name);
	const what = singular(collection);
	const chips = (
		<>
			{isNew ? <span className="chip waiting">New</span> : null}
			<ReadOnlyChip />
		</>
	);
	const url = entry.url ?? '';
	return (
		<>
			<Trail>
				<DocumentsTab />
				{over ? <OverPageTab /> : <CollectionTab name={collection.name} />}
				<CurrentHead
					back={overBack ?? { label: `Back to ${collection.label.toLowerCase()}`, onClick: () => editor.openCollection(collection.name) }}
					crumb={over ? undefined : collection.label}
					title={title}
					// Edit in context (the mockup's #item-open): open over a page, its kind beside the title.
					chips={over ? <span className="chip kind">{titleCase(what)}</span> : undefined}
					sub={
						<>
							{chips}
							{/* Edit in context (Decision 8): open over a page, it says so. M6c (G1): a document with no page of its own has no address to show. */}
							{over ? <span>{`${titleCase(what)} · open over ${over.name}`}</span> : collection.urlBase === null ? null : <span className="mono">{url || '/'}</span>}
						</>
					}
					menu={<DocMenu label={`${titleCase(what)} actions`} />}
				/>
			</Trail>
			<div className="side-body" data-document={docId(ref)}>
				<GlobalNotes />
				<DocNotices />
				<FormFields readOnly={readOnly}>
					{/* Edit in context, Decision 12: what its render shows from elsewhere, above its fields. */}
					<ReadRows blockKey={key} />
					<FieldHostProvider host={host}>
						<TitleField scope={key} help={Object.values(fields).some((f) => f.kind === 'lockup') ? TITLE_BESIDE_HEADING : undefined} />
						{formRows(fields).map((row) => {
							const control = ([name, field]: [string, Field]) => (
								<FieldControl key={`${key}:${name}`} name={name} label={field.label ?? titleCase(name)} field={field} value={data[name]} lockupIndex={0} />
							);
							return row.length === 2 ? (
								<div key={`${key}:${row[0]![0]}+`} className="two">
									{row.map(control)}
								</div>
							) : (
								control(row[0]!)
							);
						})}
					</FieldHostProvider>
					{/* Decision 4: what its render shows from Site Settings. */}
					<AlsoShows blockKey={key} />
					{/* Edit in context, Decision 3: its header and footer, when the site has more than one. */}
					<FramePickers />
					{/* M6 Decision 13: SEO ends a fields document's form. */}
					<SeoGroup />
				</FormFields>
			</div>
			<RecentStrip />
		</>
	);
}

// ── A shared block as its own document ───────────────────────────────────────

/** "Used on 4 pages" / "Not on any page yet" (the mockup's usedLabel). N counts documents of every collection. */
export const usedLabel = (n: number) => (n ? `Used on ${n} page${n === 1 ? '' : 's'}` : 'Not on any page yet');

/** The documents a shared block is used on, as listed. */
export function usedOnDocs(documents: readonly ListedDocument[], name: string): ListedDocument[] {
	const shared = documents.find((d) => d.collection === 'shared' && d.path === name);
	return (shared?.usedOn ?? []).map((u) => documents.find((d) => d.collection === u.collection && d.path === u.path)).filter((d): d is ListedDocument => !!d);
}

/** Documents as links that open them: "Home, About, Work" (as M5a lists them), or with `few`, "Home, About, Work and 9 more". */
function DocLinks({ docs, few }: { docs: readonly ListedDocument[]; few?: number }) {
	const editor = useEditor();
	const shown = few !== undefined && docs.length > few + 1 ? docs.slice(0, few) : docs;
	const more = docs.length - shown.length;
	return (
		<>
			{shown.map((d, i) => (
				<Fragment key={docId(d)}>
					{i === 0 ? '' : few !== undefined && i === shown.length - 1 && !more ? ' and ' : ', '}
					<button type="button" className="linkbtn" data-doc={docId(d)} onClick={() => void editor.openDocument({ collection: d.collection, path: d.path })}>
						{d.label}
					</button>
				</Fragment>
			))}
			{more ? <span data-more={more}>{` and ${more} more`}</span> : null}
		</>
	);
}

export function SharedDocumentLevel() {
	const editor = useEditor();
	const ref = useStore(editor.doc.state, (s) => s.ref);
	const title = useStore(editor.doc.state, (s) => s.document.title || s.entry.label);
	const block = useStore(editor.doc.state, (s) => s.document.blocks[0]);
	const isDefault = useStore(editor.doc.state, (s) => !!s.document.default);
	const documents = useStore(editor.documents);
	const isNew = useIsNew();
	const { host, data, key, readOnly } = useFormHost();
	const over = useOverPage();
	const overBack = useOverBack();
	if (!host || !key || !block) return null;
	const schema = block.known ? editor.site.blocks[block.type] : undefined;
	const fields = schema?.fields ?? {};
	const used = usedOnDocs(documents, ref.path);
	const n = used.length;
	const slot = schema?.slot;
	return (
		<>
			<Trail>
				<DocumentsTab />
				{over ? <OverPageTab /> : <CollectionTab name="shared" />}
				<CurrentHead
					back={overBack ?? { label: 'Back to shared blocks', onClick: () => editor.openCollection('shared') }}
					crumb={over ? undefined : 'Shared blocks'}
					title={title}
					// Edit in context (the mockup's #footer-field): open over a page, a "Shared" pill beside the title.
					chips={over ? <span className="chip shared">Shared</span> : undefined}
					sub={
						<>
							{isNew ? <span className="chip waiting">New</span> : null}
							<ReadOnlyChip />
							{/* Edit in context (Decision 8): "Footer · used on 12 pages · open over Home". */}
							<span>{`${schema?.label ?? 'Block'} · ${usedLabel(n)}${over ? ` · open over ${over.name}` : ''}`}</span>
						</>
					}
					menu={<DocMenu label="Shared block actions" />}
				/>
			</Trail>
			<div className="side-body" data-document={docId(ref)}>
				<GlobalNotes />
				<DocNotices />
				<TitleNote />
				{n ? (
					<div className="note select" data-note="used-on">
						<Icon name="shared" />
						<div>
							<b>Changes here show on every page that uses it</b>
							{slot ? (
								// Edit in context, Decision 3: a slot's block names a few of the pages it fills, and "N more".
								<p className="used-in">
									{isDefault ? `The default ${slot}: every page that doesn't pick another, ` : 'Picked by '}
									<DocLinks docs={used} few={3} />
								</p>
							) : (
								<p className="used-in">
									Used on <DocLinks docs={used} />
								</p>
							)}
						</div>
					</div>
				) : (
					<div className="note" data-note="used-on">
						<Icon name="shared" />
						<div>
							<b>Not on any page yet</b>
						</div>
					</div>
				)}
				{!block.known ? (
					<div className="note warn" data-note="unknown-type">
						<Icon name="warn" />
						<div>
							<b>This block's type isn't in the site's code any more</b>
							<p>Skipped on the page; kept in the file.</p>
						</div>
					</div>
				) : (
					<FormFields readOnly={readOnly}>
						<FieldHostProvider host={host}>
							<BlockHelp help={schema?.help} />
							{/* Review gaps (Decision 7): its states, switched over its own render. */}
							<StatesLine type={block.type} />
							{/* Edit in context, Decision 3: a slot's default, above its fields (the mockup's #footer-field). */}
							{slot ? <DefaultSwitch slot={slot} /> : null}
							{Object.keys(fields).length === 0 && !slot ? <p className="field-help">This block has nothing to set.</p> : null}
							{Object.entries(fields).map(([name, field]) => (
								<FieldControl key={`${key}:${name}`} name={name} label={field.label ?? titleCase(name)} field={field} value={data[name]} lockupIndex={0} />
							))}
						</FieldHostProvider>
						{/* Decision 4: what its render shows from Site Settings, and a way there. */}
						<AlsoShows blockKey={key} />
					</FormFields>
				)}
			</div>
			<RecentStrip />
		</>
	);
}

// ── Site Settings ────────────────────────────────────────────────────────────

/**
 * Why an editors entry lets nobody in (the whitelist's rules, M4 Decision 15), or null
 * when it's fine. The mockup's copy.
 */
export function editorEntryProblem(value: string): string | null {
	const entry = parseAllowEntry(value);
	if (entry.kind === 'public-domain') {
		return "Public mail domains let nobody in. Add each person's address.";
	}
	if (entry.kind === 'invalid') return 'Not an address or @domain; lets nobody in.';
	return null;
}

/** Whether an entry lets `email` in (its exact address, or its domain). */
export function entryCovers(value: string, email: string | null | undefined): boolean {
	if (!email) return false;
	const entry = parseAllowEntry(value);
	const you = email.trim().toLowerCase();
	if (entry.kind === 'address') return entry.value === you;
	if (entry.kind === 'domain') return you.endsWith(`@${entry.value}`);
	return false;
}

/** Site Settings' logo and tab icon (M5b Decision 11): image values with no alt text and no focal point. */
const BRAND_IMAGE = mediaField({ only: 'image' });
const BRAND_SLOTS = [
	{ key: 'logo', label: 'Logo', help: null, empty: 'None yet: the editor shows its own plain mark.' },
	{ key: 'icon', label: 'Tab icon', help: 'Square works best.', empty: 'None yet: the tab uses the logo.' },
] as const;

/**
 * A new logo or tab icon placed (#settings-brand). Subscribed once per editor, since Site Settings' level is off screen
 * while the picker places it.
 */
const toasting = new WeakSet<Editor>();
function brandToasts(editor: Editor) {
	if (toasting.has(editor)) return;
	toasting.add(editor);
	mediaFor(editor).placed.subscribe((p) => {
		if (!p || editor.doc.get().document.kind !== 'settings' || p.scope !== formKey(editor.doc.get())) return;
		if (p.path !== 'brand.logo' && p.path !== 'brand.icon') return;
		editor.toast(`${p.path === 'brand.logo' ? 'Logo' : 'Tab icon'} updated`, 'check');
	});
}

function BrandSlot(props: { which: (typeof BRAND_SLOTS)[number]; value: unknown }) {
	const editor = useEditor();
	brandToasts(editor);
	const { key, label, help, empty } = props.which;
	const path = `brand.${key}`;
	const set = parseMedia(props.value);
	const line = set && 'key' in set ? help : empty;
	return (
		<div className="field media-field" data-field={key} data-ff={path}>
			<div className="field-head">
				<span className="field-label">{label}</span>
				<span className="field-meta">Images only</span>
			</div>
			<MediaSlot path={path} field={BRAND_IMAGE} value={props.value} warnings={[]} pickLabel={label} brand={{ label }} />
			{line ? (
				<p className="field-help" style={{ margin: 'var(--space-1-5) 0 0' }}>
					{line}
				</p>
			) : null}
		</div>
	);
}

/**
 * Site Settings' accent (editor restyle, Decision 12): presets only, a radio group of swatches whose arrows move and
 * pick (Home and End jump). A stored colour that isn't a preset comes first as "Current", set apart by a hairline.
 * The field's value paints the whole editor in this tab at once: a preset its own slots, "Current" the committed
 * accent as the level mounted, anything else the brand store's (so undo, Discard and "Current" put the committed accent
 * back). It isn't undone on leaving.
 */
function AccentPicker(props: { value: string; committed: { hex: string; ink: string; edge: string }; readOnly: boolean; onPick: (hex: string) => void }) {
	const editor = useEditor();
	const presets = editor.site.presets;
	const { value, committed } = props;
	const current = !presetOf(presets, value) ? value : !presetOf(presets, committed.hex) ? committed.hex : null;
	const chosen = presetOf(presets, value);
	// "Current" (the committed accent as the level mounted) paints that colour, not the brand store's, which the sweep
	// moves to a kept pick; only a hand-edited value that is neither falls back to the brand store.
	const isCommitted = !chosen && value.toLowerCase() === committed.hex;
	useEffect(() => {
		editor.paintAccent(chosen ? { accent: chosen.hex, ink: chosen.ink, edge: chosen.edge } : isCommitted ? { accent: committed.hex, ink: committed.ink, edge: committed.edge } : null);
	}, [editor, chosen, isCommitted, committed]);
	// "Current" takes brand.ts's ink and edge as the committed accent had them (a colour typed in by hand before the
	// presets, which only the server can compute, is drawn on --on-fill and itself).
	const currentLook = current === committed.hex ? committed : { ink: 'var(--on-fill)', edge: current ?? '' };
	const swatches = [...(current ? [{ hex: current, name: 'Current', ink: currentLook.ink, edge: currentLook.edge }] : []), ...presets];
	// The arrows' pick takes the focus once it's drawn (the radio group's roving tabindex).
	const group = useRef<HTMLDivElement>(null);
	const [focusHex, setFocusHex] = useState<string | null>(null);
	useEffect(() => {
		if (!focusHex) return;
		group.current?.querySelector<HTMLElement>(`.preset[data-hex="${focusHex}"]`)?.focus();
		setFocusHex(null);
	}, [focusHex, value]);
	const pick = (hex: string, focus = false) => {
		if (focus) setFocusHex(hex);
		if (hex === value || props.readOnly) return;
		props.onPick(hex);
		const p = presetOf(presets, hex);
		editor.toast(p ? `The accent is now ${p.name}` : 'The accent is back to its current colour', 'check');
	};
	const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
		const n = e.key === 'Home' ? 0 : e.key === 'End' ? swatches.length - 1 : /^Arrow(Right|Down)$/.test(e.key) ? (i + 1) % swatches.length : /^Arrow(Left|Up)$/.test(e.key) ? (i - 1 + swatches.length) % swatches.length : -1;
		if (n < 0) return;
		e.preventDefault();
		pick(swatches[n]!.hex, true);
	};
	const button = (s: { hex: string; name: string; ink: string; edge: string }, i: number) => {
		const on = s.hex === value;
		const label = `${s.name}, ${s.hex.toUpperCase()}`;
		return (
			<button
				key={s.name}
				type="button"
				role="radio"
				className="preset"
				aria-checked={on}
				tabIndex={on ? 0 : -1}
				disabled={props.readOnly}
				data-hex={s.hex}
				aria-label={label}
				title={`${s.name} · ${s.hex.toUpperCase()}`}
				style={{ '--sw': s.hex, '--sw-ink': s.ink, '--sw-edge': s.edge } as CSSProperties}
				onClick={() => pick(s.hex)}
				onKeyDown={(e) => onKey(e, i)}
			>
				<Icon name="check" size="sm" />
			</button>
		);
	};
	return (
		<>
			<div className="field-head">
				<label id="set-accent-l">Accent colour</label>
				<span className="field-meta" id="set-accent-n">
					<b>{chosen ? chosen.name : 'Current'}</b> · <span className="mono">{value.toUpperCase()}</span>
				</span>
			</div>
			<div className="presets" role="radiogroup" ref={group} aria-labelledby="set-accent-l" aria-describedby="set-accent-h">
				{current ? (
					<>
						{button(swatches[0]!, 0)}
						<span className="presets-sep" aria-hidden="true" />
					</>
				) : null}
				{presets.map((p, i) => button(p, i + (current ? 1 : 0)))}
			</div>
			<p className="field-help" id="set-accent-h">
				{current ? 'The first one, Current, is the colour this site had before there were presets. It keeps working until you pick another. ' : ''}
				It fills the main buttons, switches when they’re on, and sign-in’s main button. Its text turns dark or light to stay readable. Publish stays green.
			</p>
		</>
	);
}

export function SettingsLevel() {
	const editor = useEditor();
	const ref = useStore(editor.doc.state, (s) => s.ref);
	const { host, data, key, readOnly } = useFormHost();
	const brandNow = useStore(editor.brand);
	// Decision 12: "Current" is the committed accent as it was when the level mounted (a pick changes the field, never
	// the brand store), so it stays in the row while Site Settings is open and is gone on the next visit once kept.
	const [committedAccent] = useState(() => {
		const b = editor.brand.get();
		return { hex: b.accent.toLowerCase(), ink: b.accentInk, edge: b.accentEdge };
	});
	const [adding, setAdding] = useState('');
	const [confirm, setConfirm] = useState<number | null>(null);
	const over = useOverPage();
	const overBack = useOverBack();
	if (!host || !key) return null;
	const editors = Array.isArray(data.editors) ? (data.editors as string[]) : [];
	const brand = (asObject(data.brand) ?? {}) as { name?: string; accent?: string; logo?: unknown; icon?: unknown };
	const accent = (/^#[0-9a-f]{6}$/i.test(brand.accent ?? '') ? brand.accent! : brandNow.accent).toLowerCase();
	// Review gaps (Decision 9a): the forms' words are Site Settings fields too, drawn under Forms (SettingsM6), not here.
	const { formWords: _formWords, ...siteFields } = formFields(editor.site, 'settings');
	const you = editor.you?.email ?? null;
	const addProblem = adding.trim() ? editorEntryProblem(adding) : null;
	const remove = (i: number, sure = false) => {
		if (!sure && entryCovers(editors[i]!, you)) {
			setConfirm(i);
			return;
		}
		setConfirm(null);
		host.removeItem('editors', i, `Removed ${editors[i]}`);
	};
	const add = () => {
		const value = adding.trim();
		if (!value || readOnly) return;
		host.set('editors', [...editors, value]);
		setAdding('');
		editor.announce(editorEntryProblem(value) ?? `Added ${value}.`);
	};
	return (
		<>
			<Trail>
				<DocumentsTab />
				<OverPageTab />
				<CurrentHead
					back={overBack ?? { label: 'Back to documents', onClick: () => editor.goTo('documents') }}
					title="Site Settings"
					chips={<ReadOnlyChip />}
					sub={over ? `One document for the whole site · open over ${over.name}` : undefined}
				/>
			</Trail>
			<div className="side-body" data-document={docId(ref)}>
				<GlobalNotes />
				<DocNotices />
				<FormFields readOnly={readOnly}>
					<FieldHostProvider host={host}>
						{/* Edit in context, Decision 4: the site's own fields first, the package's setup sections after. */}
						{Object.keys(siteFields).length ? (
							<section className="set-sec" data-section="site-settings">
								<h3>The site</h3>
								{Object.entries(siteFields).map(([name, field]) => (
									<FieldControl key={`${key}:${name}`} name={name} label={field.label ?? titleCase(name)} field={field} value={data[name]} />
								))}
							</section>
						) : null}
						<section className="set-sec" data-ff="editors">
							<h3>Who can sign in</h3>
							<p className="lead">An exact address lets one person in; an @domain lets in everyone with an address there.</p>
							<div className="eds" data-path="editors">
								{editors.map((value, i) => {
									const domain = value.trim().startsWith('@');
									const why = editorEntryProblem(value);
									const asking = confirm === i;
									return (
										<div key={`${i}:${value}`} className={`ed${asking || why ? ' is-confirm' : ''}`} data-editor={value} data-warned={why ? '' : undefined}>
											<span className="tile" aria-hidden="true">
												{domain ? '@' : <Icon name="mail" size="sm" />}
											</span>
											<span className="t">
												<b>{value}</b>
												{/* The tile already says which kind it is: only a domain gets a line, saying who it lets in. */}
												{why ? <small style={{ color: 'var(--status-warning)' }}>Lets nobody in</small> : domain ? <small>Everyone at {value.trim().slice(1)}</small> : null}
											</span>
											<button type="button" className="ib" aria-label={`Remove ${value}`} disabled={readOnly} onClick={() => remove(i)}>
												<Icon name="x" size="sm" />
											</button>
											{asking ? (
												<div className="ed-q" role="alert" data-note="remove-self">
													This covers your own address, {you}. Remove it and you'll be signed out once the change applies.
													<div className="acts">
														<button type="button" className="btn sm danger" data-act="remove-self" onClick={() => remove(i, true)}>
															Remove and sign me out
														</button>
														<button type="button" className="btn sm" onClick={() => setConfirm(null)}>
															Keep it
														</button>
													</div>
												</div>
											) : null}
											{why ? (
												<div className="ed-q" style={{ color: 'var(--status-warning)' }} data-why="editor">
													{why}
												</div>
											) : null}
										</div>
									);
								})}
							</div>
							<form
								className="ed-add"
								data-form="editor"
								onSubmit={(e) => {
									e.preventDefault();
									add();
								}}
							>
								<input
									className="input"
									id="ed-new"
									value={adding}
									placeholder="name@example.com or @example.com"
									aria-label="Add an address or a domain"
									autoComplete="off"
									spellCheck={false}
									aria-describedby={addProblem ? 'ed-err' : undefined}
									onChange={(e) => setAdding(e.target.value)}
								/>
								<button className="btn" type="submit">
									Add
								</button>
							</form>
							{addProblem ? (
								<p className="field-warn" id="ed-err">
									<Icon name="warn" size="sm" />
									<span>{addProblem}</span>
								</p>
							) : null}
							<div className="fixed-line">
								<Icon name="lock" size="sm" />
								<span>The agency can always sign in.</span>
							</div>
						</section>
						<section className="set-sec">
							<h3>Editor branding</h3>
							<p className="lead">Doesn't change the site.</p>
							<div className="field" data-ff="brand.name">
								<div className="field-head">
									<label htmlFor="set-name">Site name</label>
								</div>
								<input className="input" id="set-name" data-path="brand.name" value={brand.name ?? ''} placeholder="Site" autoComplete="off" onChange={(e) => host.set('brand.name', e.target.value)} />
							</div>
							{BRAND_SLOTS.map((which) => (
								<BrandSlot key={which.key} which={which} value={brand[which.key] ?? null} />
							))}
							<div className="field" data-ff="brand.accent">
								<AccentPicker value={accent} committed={committedAccent} readOnly={readOnly} onPick={(hex) => host.set('brand.accent', hex)} />
								<div className="accent-try" aria-hidden="true">
									<span className="logo-slot">
										<BrandMark />
									</span>
									<span className="nm">{brandNow.name}</span>
									<span className="btn accent">Send sign-in link</span>
								</div>
							</div>
						</section>
						{/* M6 Decision 14: the default SEO, the Google tag and Form emails. */}
						<SettingsM6 data={data} />
					</FieldHostProvider>
				</FormFields>
			</div>
			<RecentStrip />
		</>
	);
}
