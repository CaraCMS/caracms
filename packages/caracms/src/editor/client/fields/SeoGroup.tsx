/**
 * SEO (M6 Decision 13; the mockup's #seo-page, #seo-long, #seo-defaults,
 * #seo-case): a document's own `seo` key, as one collapsed group that says what's set.
 * At the foot of a section-builder page's block list (below Add block), and at the end of
 * a fields document's form. Only on collections with a URL.
 *
 * - **Search title** and **Search description**: plain text with M5a's count and M6's
 *   soft limits (60 and 160, seo.ts). Over the limit the count and a note turn amber, and
 *   nothing is blocked.
 * - **Share image**: an image-only media slot with **no alt input** (like the brand's
 *   logo, M5b Decision 11) that may have a focal point; never in Publish's alt summary.
 * - Blank parts fall back to Site Settings' defaults (the placeholders say what).
 *
 * The values live in the document store beside the blocks (`SEO_SCOPE`, document-store.ts):
 * clearing the last part removes `seo` from the file, and a file with none is untouched.
 *
 * `SoftText` is also Site Settings' (its SEO defaults).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { media as mediaField } from '../../../fields.ts';
import { parseMedia } from '../../../media-value.ts';
import { SETTINGS_PATH } from '../../../reserved.ts';
import { SEO_DESCRIPTION_SOFT_LIMIT, SEO_TITLE_SOFT_LIMIT } from '../../../seo.ts';
import { ENDPOINTS, sameDoc, type AnyOpenedDocument } from '../../types.ts';
import { useEditor, useStore } from '../context.tsx';
import type { Editor, View } from '../editor.ts';
import { Icon } from '../shell/Icons.tsx';
import { SEO_SCOPE } from '../state/document-store.ts';
import { createStore, type Store } from '../state/store.ts';
import { FieldFrame } from './FieldFrame.tsx';
import { FieldHostProvider, parseBase, useHost, type FieldHost } from './host.tsx';
import { MediaSlot } from './MediaField.tsx';

const TITLE_WHY = 'search results usually cut a title off around here';
const DESC_WHY = 'search results usually cut a description off around here';
const SHARE_IMAGE = mediaField({ only: 'image' });

/**
 * A text field with a count and a soft limit (M6 Decision 13, Decision 17's intro): over
 * `max`, the count and a note turn amber; nothing is blocked.
 */
export function SoftText(props: {
	scope: string;
	name: string;
	label: string;
	value: string;
	max: number;
	multiline?: boolean;
	placeholder?: string;
	help?: ReactNode;
	overWhy?: string;
	disabled?: boolean;
	onChange: (value: string) => void;
}) {
	const id = `f-${props.scope}-${props.name}`.replace(/[^\w-]/g, '-');
	const n = props.value.length;
	const over = n > props.max;
	const input = props.multiline ? (
		<textarea
			className="input"
			id={id}
			data-path={props.name}
			rows={3}
			value={props.value}
			placeholder={props.placeholder}
			spellCheck={false}
			disabled={props.disabled}
			aria-describedby={over ? `${id}-w` : undefined}
			onChange={(e) => props.onChange(e.target.value)}
		/>
	) : (
		<input
			className="input"
			id={id}
			data-path={props.name}
			value={props.value}
			placeholder={props.placeholder}
			autoComplete="off"
			spellCheck={false}
			disabled={props.disabled}
			aria-describedby={over ? `${id}-w` : undefined}
			onChange={(e) => props.onChange(e.target.value.replace(/\n+/g, ' '))}
		/>
	);
	return (
		<FieldFrame
			blockKey={props.scope}
			name={props.name}
			label={props.label}
			htmlFor={id}
			meta={
				<span className={`field-meta${over ? ' soft-over' : ''}`} data-count={props.max} data-soft="">
					{n} / {props.max}
				</span>
			}
		>
			{props.help ? <p className="field-help">{props.help}</p> : null}
			{input}
			{over ? (
				<p className="field-warn" id={`${id}-w`} data-over="">
					<Icon name="warn" size="sm" />
					<span>
						Over {props.max}: {props.overWhy ?? 'it may be cut short'}.
					</span>
				</p>
			) : null}
		</FieldFrame>
	);
}

/** The share image (a page's, or Site Settings' default): image-only, no alt input, a focal point allowed. */
export function ShareImage(props: { name: string; label: string; help: string; value: unknown }) {
	const host = useHost();
	return (
		<FieldFrame blockKey={host.scope} name={props.name} label={props.label} className="media-field" meta={<span className="field-meta">Images only</span>}>
			<p className="field-help">{props.help}</p>
			<MediaSlot path={props.name} field={SHARE_IMAGE} value={props.value} warnings={[]} pickLabel={props.label} noAlt />
		</FieldFrame>
	);
}

/** "Title, description and image set", or "Uses the site’s defaults". */
export function seoSummary(seo: Record<string, unknown> | undefined): string {
	const text = (v: unknown) => typeof v === 'string' && v.trim() !== '';
	const set = [text(seo?.title) && 'title', text(seo?.description) && 'description', parseMedia(seo?.image) && 'image'].filter((x): x is string => !!x);
	if (!set.length) return 'Uses the site’s defaults';
	const list = set.length < 2 ? set[0]! : `${set.slice(0, -1).join(', ')} and ${set.at(-1)}`;
	return `${list[0]!.toUpperCase()}${list.slice(1)} set`;
}

/** The page's seo host: its fields picked at the document level as `seo.<part>` (so they never ring the form's own `title`). */
function seoHost(editor: Editor, raw: Record<string, unknown> | undefined, readOnly: boolean): FieldHost {
	return {
		scope: SEO_SCOPE,
		picked: (view: View) => (view.level === 'document' && view.field?.startsWith('seo.') ? view.field.slice(4) : null),
		pick(path) {
			if (editor.view.get().field !== `seo.${path}`) editor.view.update({ field: `seo.${path}`, picked: false });
		},
		set: (path, value, options) => editor.doc.setField(SEO_SCOPE, path, value, options),
		removeItem() {},
		raw: (name) => (raw && Object.hasOwn(raw, name) ? raw[name] : undefined),
		readOnly,
	};
}

/** The group, for the open document. Null for a document without a URL (a collection with no `urlBase`). */
export function SeoGroup() {
	const editor = useEditor();
	const session = useStore(editor.doc.state);
	const readOnly = useStore(editor.access, (a) => a.readOnly);
	const brand = useStore(editor.brand, (b) => b.name);
	const settings = useSiteSettings();
	const [open, setOpen] = useState(false);
	const collection = editor.site.collections.find((c) => c.name === session.ref.collection);
	const raw = useMemo(() => {
		const base = parseBase(session.base);
		const seo = base && typeof base === 'object' ? (base as Record<string, unknown>).seo : undefined;
		return seo && typeof seo === 'object' && !Array.isArray(seo) ? (seo as Record<string, unknown>) : undefined;
	}, [session.base]);
	const host = useMemo(() => seoHost(editor, raw, readOnly), [editor, raw, readOnly]);
	if (!collection?.urlBase || (session.document.kind !== 'sections' && session.document.kind !== 'fields')) return null;
	const seo = session.document.seo ?? {};
	const str = (v: unknown) => (typeof v === 'string' ? v : '');
	const isHome = sameDoc(session.ref, editor.site.home);
	const defaults = settings?.seo ?? {};
	const fallback = isHome ? str(defaults.title).trim() || brand : `${session.document.title || session.entry.label} · ${brand}`;
	return (
		<details className="fgroup seo" open={open} data-seo="" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
			<summary>
				SEO <span className="s">· {seoSummary(session.document.seo)}</span>
				<Icon name="chev-r" size="sm" />
			</summary>
			<div className="in">
				<FieldHostProvider host={host}>
					<SoftText
						scope={SEO_SCOPE}
						name="title"
						label="Search title"
						value={str(seo.title)}
						max={SEO_TITLE_SOFT_LIMIT}
						placeholder={fallback}
						help={`Blank is “${fallback}”.`}
						overWhy={TITLE_WHY}
						disabled={readOnly}
						onChange={(v) => host.set('title', v)}
					/>
					<SoftText
						scope={SEO_SCOPE}
						name="description"
						label="Search description"
						value={str(seo.description)}
						max={SEO_DESCRIPTION_SOFT_LIMIT}
						multiline
						placeholder={str(defaults.description)}
						help="Blank uses the site default."
						overWhy={DESC_WHY}
						disabled={readOnly}
						onChange={(v) => host.set('description', v.replace(/\n+/g, ' '))}
					/>
					<ShareImage
						name="image"
						label="Share image"
						value={seo.image ?? null}
						help="1200 × 630. Blank uses the site default."
					/>
				</FieldHostProvider>
			</div>
		</details>
	);
}

export { TITLE_WHY, DESC_WHY };

// ── Site Settings as the page's fields need it ───────────────────────────────

/** What a page's fields read from Site Settings: the SEO defaults (fallbacks) and who gets each form's email. */
export interface SettingsView {
	seo: Record<string, unknown>;
	formRecipients: Record<string, string[]>;
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const viewOf = (data: Record<string, unknown>): SettingsView => {
	const recipients: Record<string, string[]> = {};
	for (const [id, list] of Object.entries(asObject(data.formRecipients))) if (Array.isArray(list)) recipients[id] = list.filter((x): x is string => typeof x === 'string');
	return { seo: asObject(data.seo), formRecipients: recipients };
};

interface SettingsSource {
	store: Store<SettingsView | null>;
	/** Read Site Settings' draft again, once this tab's own changes to it are sent. The latest read wins. */
	refresh(): void;
}
const settingsSources = new WeakMap<Editor, SettingsSource>();

function settingsFor(editor: Editor): SettingsSource {
	let source = settingsSources.get(editor);
	if (source) return source;
	const store = createStore<SettingsView | null>(null);
	// While Site Settings is open, its edited values, as they're typed.
	const follow = (s: ReturnType<Editor['doc']['get']>) => {
		if (s.document.kind === 'settings') store.set(viewOf(s.document.blocks[0]?.data ?? {}));
	};
	follow(editor.doc.get());
	editor.doc.state.subscribe(follow);
	let reads = 0;
	source = {
		store,
		refresh() {
			const ticket = ++reads;
			// Its own changes first (a recipient added a moment ago), so the draft read has them.
			void (editor.keeper?.flush() ?? Promise.resolve())
				.then(() => fetch(`${ENDPOINTS.document}?collection=settings&path=${encodeURIComponent(SETTINGS_PATH)}`, { headers: { Accept: 'application/json' } }))
				.then(async (response) => {
					if (!response.ok || ticket !== reads) return;
					const opened = (await response.json()) as AnyOpenedDocument;
					if (ticket === reads && opened.document.kind === 'settings' && editor.doc.get().document.kind !== 'settings') store.set(viewOf(opened.document.data as Record<string, unknown>));
				})
				.catch(() => undefined);
		},
	};
	settingsSources.set(editor, source);
	return source;
}

/**
 * Site Settings' SEO defaults and form recipients, for fields on another document (the
 * fallbacks' placeholders, the Form block's "its email goes to"). While Site Settings is
 * open, its edited values as they're typed; otherwise its draft, read again each time a
 * field that needs it is shown (someone else, or another tab, may have changed it), with
 * the last known shown meanwhile. Null until first read.
 */
export function useSiteSettings(): SettingsView | null {
	const editor = useEditor();
	const source = settingsFor(editor);
	const view = useStore(source.store);
	const settingsOpen = useStore(editor.doc.state, (s) => s.document.kind === 'settings');
	useEffect(() => {
		if (!settingsOpen) source.refresh();
	}, [source, settingsOpen]);
	return view;
}
