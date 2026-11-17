/**
 * Editing from the page (Decision 12; M2 → "click to edit", "text typed on the
 * page"), in the iframe on screen:
 *
 * - **Click to edit:** a click opens that block's level and picks the field under
 *   it ("Picked from the page"). A plain text field is then typed right there; a
 *   lockup opens its sidebar field (lockups are edited only in the sidebar); a
 *   click on a skipped block's pill opens that block (the overlay's own button).
 * - **Typing on the page:** plain text fields are `contenteditable="plaintext-only"`
 *   in preview renders (Text.astro). What's typed goes to the store with
 *   `origin: 'page'`; the driver mirrors it into the other two iframes instead of
 *   rendering (Decision 13), and the sidebar field follows. One-line fields take no
 *   line breaks (Enter leaves the field, a paste's breaks become spaces).
 * - **Rich text typed on the page** (on-page rich text, Decisions 1, 5–8, 10): a
 *   top-level rich-text field (`tabindex="0"` in preview renders, RichText.astro)
 *   gets the page editor (page-editor.ts: /admin's own Tiptap mounted on the field's
 *   element) in the iframe on screen, at most one: mounted when the pointer enters
 *   the field or focus reaches it (a tap, Tab), so the first press lands on it.
 *   **A typing session** is focus in the editor or in the overlay layer of its iframe
 *   (where its formatting bar and link popover live); while it's on, the editor stays mounted
 *   and `typing` stays set. It's torn down when no session is on and the pointer has
 *   left the field, when the block's level closes, another document opens or the
 *   width changes, and when the tab goes read-only; the element is left exactly as a
 *   render. Each edit is stored with `origin: 'page'` (the driver mirrors it); a
 *   change from elsewhere is put into the mounted editor (Decision 8). Rich text in
 *   a list item, and a shared entry on a page that uses it, stay in the sidebar.
 * - **Hover:** the block and field under the pointer, for the overlays.
 * - **Following the sidebar:** a block or field picked in the sidebar is scrolled
 *   into view in the preview if it's out of sight.
 * - **Keys in the page:** Esc leaves the field, then goes up a level, as in the sidebar;
 *   in rich text the formatting bar's menu or link popover closes first (Esc and ⌘K
 *   reach the bar through `onEditorKey`; overlays/rich-text-bar.ts).
 *
 * The caret on the page survives every re-render whether focus is here or in the
 * sidebar: the driver saves and restores each iframe's selection around a morph
 * (selection.ts; Decision 13). Nothing here changes that.
 *
 * **Edit in context** (its Decisions 6–11, 13, 14): what an element belongs to is its claim
 * (places.ts): the open document's own (a block, a page field as `PAGE_SCOPE`, or its fields
 * drawn as a source), the page under an opened document, or another document drawn as a source.
 *
 * - **Another document** (a footer, Site Settings' phone, a card): in the page's frame one
 *   click opens it over the page with the field picked (a field typed on the page keeps the
 *   browser's caret where the click landed); inside a block the first click selects the block
 *   and the next opens it (Decision 7). With a document already over the page, one click
 *   replaces it (no stack).
 * - **The page under an opened document** isn't edited (Decision 8): nothing is typed in it,
 *   and a click on one of its blocks or fields goes back to the page with that picked.
 * - **The page's own fields** (`data-cms-page`, Decision 10a) are one click, as the frame is:
 *   picked in Page details (`page.<path>`); a click on the region but no field opens Page details
 *   at its top.
 * - **A field marked without its value** (no `data-cms-kind`, Decision 10b) is picked in the
 *   sidebar with its control focused; nothing is typed on the page.
 * - **The frame a site draws itself** (Decision 13): a click on it, not on a link it follows,
 *   shows "Edited elsewhere: open Site Settings →" where it landed (`elsewhere`; drawn by
 *   overlays/source-marks.ts).
 * - **Live mode** (Decision 14): an opened document someone else holds is read-only: its fields
 *   on the page aren't typed in, but the page's clicks still go where they go.
 */
import type { Editor } from '../editor.ts';
import type { Editor as TiptapEditor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { createStore, type Store } from '../state/store.ts';
import { sameDoc, type DocRef, type Width } from '../../types.ts';
import type { PreviewFrame } from './driver.ts';
import { fieldText } from './field-text.ts';
import { blockIndexOf, contextRoots, fieldElements, inUnmarkedFrame, skippedAnchor, skippedTop, type Ctx } from './markers.ts';
import { claimOf, ownCtxs, pageFieldPath, type Claim } from './places.ts';
import { PAGE_SCOPE } from '../state/document-store.ts';
import { mountPageEditor, pointInField, positionOf, type MountedPageEditor } from './page-editor.ts';
import { mountedIn, setMounted } from './page-editor-registry.ts';
import { fieldsOfBlock } from '../state/schema.ts';
import { fieldAt, getAtPath, isKeyPath, richTextOptions } from '../../../fields.ts';
import type { RichTextOptions } from '../../../rich-text.ts';

export interface Typing {
	/** The block's key in the document store. */
	key: string;
	field: string;
	width: Width;
}

export interface PageHover {
	/** The block's index in the rendered document; -1 when the pointer isn't on one of the open document's blocks. */
	block: number;
	field: string | null;
	/**
	 * Edit in context: the open document's key it's over (a block's, `PAGE_SCOPE`, or a form's
	 * drawn as a source), else null; and the field's element.
	 */
	key?: string | null;
	fieldEl?: HTMLElement | null;
	/** Another document drawn as a source (its root, and the page's block it sits in), else null. */
	source?: { ref: DocRef; root: HTMLElement; field: string | null; fieldEl: HTMLElement | null; inBlock: number | null } | null;
}

/** Edit in context, Decision 13: a click on the frame a site draws itself, where it landed. */
export interface Elsewhere {
	width: Width;
	el: HTMLElement;
}

/** The page editor mounted in the iframe on screen (on-page rich text), for its formatting bar (overlays/rich-text-bar.ts). */
export interface PageEditorState {
	/** The block's key in the document store, and the (top-level) rich-text field. */
	key: string;
	field: string;
	width: Width;
	frame: PreviewFrame;
	/** The mounted Tiptap editor (its events: 'transaction', 'selectionUpdate', 'focus', 'blur'). */
	editor: TiptapEditor;
	view: EditorView;
	/** The field's options (its headings, links): the bar shows only its controls. */
	options: RichTextOptions;
	/** A typing session is on: focus is in the editor or in its iframe's overlay layer. */
	session: boolean;
}

export interface PageEdit {
	/** The field being typed on the page (plain text, or rich text during a typing session), or null. */
	typing: Store<Typing | null>;
	/** The page editor mounted in the iframe on screen, or null (published on mount, teardown and session changes). */
	pageEditor: Store<PageEditorState | null>;
	/** What the pointer is over in the iframe on screen, or null. */
	hover: Store<PageHover | null>;
	/** Edit in context, Decision 13: the "Edited elsewhere" chip's place, or null. */
	elsewhere: Store<Elsewhere | null>;
	/**
	 * Keys pressed in the page editor, before its own (on-page rich text, Decision 2: the
	 * bar's ⌘K and Esc, rich-text-bar.ts). Return true when handled. Returns a remove.
	 */
	onEditorKey(handler: (event: KeyboardEvent) => boolean): () => void;
	/** A key the bar took elsewhere (its popover's search): page-edit's Esc skips it, as it does `onEditorKey`'s. */
	claimKey(event: Event): void;
	/** Scroll the iframe on screen so a block (or a field in it) is in view; `index` may be the open document's contexts (markers.ts). */
	reveal(index: number | readonly Ctx[], field?: string | null, options?: { instant?: boolean }): void;
	destroy(): void;
}

const LAYER = '#cms-overlays';
/** A `<style>` in each frame's `<head>` (never morphed): over a page, the page's blocks and fields take the default cursor. */
const OVER_STYLE_ID = 'cms-over-css';
const OVER_CSS = 'html[data-cms-over] :is([data-cms-block],[data-cms-document],[data-cms-page]),html[data-cms-over] :is([data-cms-block],[data-cms-document],[data-cms-page]) :not([data-cms-source]):not([data-cms-source] *){cursor:default}';
const made = new WeakMap<Editor, PageEdit>();

/**
 * Focus a field in the block level's sidebar (a lockup's first line), once it's
 * rendered. `field` may be a dotted path (M5a Decision 16): the control for that
 * path (`data-path`) inside the field's frame, once a list has opened the row that
 * holds it (`credits.1.name`); the field's first control otherwise.
 */
export function focusSidebarField(field: string, tries = 12): void {
	// A page field (`page.<path>`, edit in context Decision 10a): its frame in Page details, by the path inside.
	const page = field.startsWith(PAGE_PREFIX);
	const path = page ? field.slice(PAGE_PREFIX.length) : field;
	// The field's frame: the longest `data-ff` the path starts with, at a path-part
	// boundary (a group's fields have frames of their own: `left.button`).
	const frameOf = (): { frame: HTMLElement; name: string } | null => {
		let best: { frame: HTMLElement; name: string } | null = null;
		const frames = page ? '[data-pane-level="document"] [data-page-fields] .field-frame[data-ff]' : '[data-pane-level="block"] .field-frame[data-ff], [data-pane-level="document"] [data-form] .field-frame[data-ff]';
		for (const frame of document.querySelectorAll<HTMLElement>(frames)) {
			const name = frame.dataset.ff!;
			if ((path === name || path.startsWith(`${name}.`)) && (!best || name.length > best.name.length)) best = { frame, name };
		}
		return best;
	};
	// M3's controls first (a lockup's lines before its Main lines / Phone lines switch), then any control.
	const controls = 'input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button.btn:not([disabled])';
	const any = '[contenteditable="true"],button:not([disabled])';
	const attempt = (left: number) => {
		// The block level's fields, or (M5a) the form of a fields document, a shared block or Site Settings.
		const found = frameOf();
		const frame = found?.frame;
		const exact = frame?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
		// A nested path waits for its row to open; past the tries, the field's own control will do.
		const input = exact ?? (path === found?.name || left === 0 ? (frame?.querySelector<HTMLElement>(controls) ?? frame?.querySelector<HTMLElement>(any)) : null);
		// A rich-text field's editor mounts in an effect, a frame or so after its frame renders: until then the
		// frame holds only its toolbar, and the fallback would focus Bold (a list item's body, clicked on the page).
		const mounting = !exact && left > 0 && !!frame?.querySelector('.rt-mount:not(:has(.ProseMirror))');
		if (!frame || !input || mounting) {
			if (left > 0) requestAnimationFrame(() => attempt(left - 1));
			return;
		}
		(input.closest('.item, .btnf, .ref') ?? frame).scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
		input.focus({ preventScroll: true });
		if (input instanceof HTMLInputElement && /^(text|search|url|tel)$/.test(input.type)) input.setSelectionRange(input.value.length, input.value.length);
	};
	requestAnimationFrame(() => attempt(tries));
}

const PAGE_PREFIX = pageFieldPath('');

/** Page details (a section builder's page fields) at its top: opened and scrolled into view, once rendered. */
function revealPageFields(tries = 12): void {
	const attempt = (left: number) => {
		const section = document.querySelector<HTMLElement>('[data-pane-level="document"] [data-page-fields]');
		if (!section) {
			if (left > 0) requestAnimationFrame(() => attempt(left - 1));
			return;
		}
		if (section instanceof HTMLDetailsElement && !section.open) section.open = true;
		section.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
	};
	requestAnimationFrame(() => attempt(tries));
}

/**
 * A top-level text or rich-text field, or one in a group (`left.heading`), is typed on the
 * page (M5a Decision 13; on-page rich text, Decision 1); everything else (a list item's
 * field, a lockup) opens in the sidebar.
 */
const typedOnPage = (kind: string | null, field: string) => (kind === 'text' || kind === 'richText') && isKeyPath(field);

/** A rich-text field the page editor can mount on: top level, focusable in the preview render (RichText.astro). */
const isPageRichText = (el: Element | null | undefined): el is HTMLElement =>
	!!el && el.matches('[data-cms-kind="richText"][data-cms-field][tabindex]') && isKeyPath(el.getAttribute('data-cms-field')!);

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function pageEditFor(editor: Editor): PageEdit | null {
	const driver = editor.preview;
	if (!driver || typeof window === 'undefined') return null;
	const existing = made.get(editor);
	if (existing) return existing;

	const typing = createStore<Typing | null>(null);
	const hover = createStore<PageHover | null>(null);
	const elsewhere = createStore<Elsewhere | null>(null);
	const pageEditor = createStore<PageEditorState | null>(null);
	const editorKeys = new Set<(event: KeyboardEvent) => boolean>();
	/** Keys an `onEditorKey` handler took (ProseMirror prevents every Esc, so defaultPrevented can't say). */
	const claimed = new WeakSet<Event>();
	const stops: (() => void)[] = [];

	/** The preview has settled on a page (nothing is opening). */
	const settled = () => !editor.previewStatus.get().opening && !editor.view.get().opening;
	/** The preview shows the document the sidebar has open: its page is edited. */
	const live = () => settled() && sameDoc(editor.previewStatus.get().showing, editor.doc.get().ref);
	/** Edit in context (Decision 8): the open document is shown over the page on screen. */
	const over = () => {
		const o = editor.over.get();
		return settled() && !!o && sameDoc(editor.previewStatus.get().showing, o.page) && !sameDoc(o.page, editor.doc.get().ref);
	};
	const visible = (frame: PreviewFrame) => frame.width === editor.view.get().width;
	/** M4 (Decision 9): read-only (a lock, held edits, signed out): no typing on the page. */
	const readOnly = () => editor.access.get().readOnly;
	/**
	 * Clicks go somewhere: on the page that's open unless it's read-only (its veil), and always
	 * over a page (Decision 14: the opened document's lock leaves the page's clicks alone).
	 */
	const clickable = () => (live() && !readOnly()) || over();
	const elementOf = (target: EventTarget | null): Element | null =>
		target && (target as Node).nodeType === 1 ? (target as Element) : ((target as Node | null)?.parentElement ?? null);
	const inLayer = (el: Element) => !!el.closest(LAYER);

	/** What an element on the page belongs to (places.ts), while the preview has settled. */
	const claim = (el: Element): Claim | null => (live() || over() ? claimOf(editor.doc.get(), editor.previewStatus.get().showing, el) : null);
	/** The open document's claim on an element (a block, its page fields, its fields drawn as a source), or null. */
	const own = (el: Element) => {
		const c = claim(el);
		return c?.kind === 'own' ? c : null;
	};
	/** Where the open document's key is drawn on the page shown. */
	const ctxsOf = (key: string): Ctx[] => ownCtxs(editor.doc.get(), editor.previewStatus.get().showing, key);

	/** A field's descriptor in the open document: a block's, or a page field (`PAGE_SCOPE`). */
	const descriptorOf = (key: string, field: string) => {
		const session = editor.doc.get();
		if (key === PAGE_SCOPE) {
			const collection = editor.site.collections.find((c) => c.name === session.ref.collection);
			return collection?.kind === 'sections' && collection.fields ? fieldAt(collection.fields, field) : undefined;
		}
		const block = editor.doc.block(key);
		return block?.known ? fieldAt(fieldsOfBlock(editor.site, session.document, session.ref.collection, block), field) : undefined;
	};
	const valueOf = (key: string, field: string): unknown => (key === PAGE_SCOPE ? getAtPath(editor.doc.get().document.data, field) : getAtPath(editor.doc.block(key)?.data, field));

	const isMultiline = (key: string, field: string) => {
		const descriptor = descriptorOf(key, field);
		return descriptor?.kind === 'text' ? descriptor.multiline : false;
	};

	/** The view holds this key's fields open: its block (or form), or Page details for `PAGE_SCOPE`. */
	const holds = (view: ReturnType<typeof editor.view.get>, key: string) =>
		key === PAGE_SCOPE ? view.level === 'document' && !!view.field?.startsWith(PAGE_PREFIX) : editor.fieldsOpen(view) && view.block === key;

	/** Pick a field of the open document (`picked`: from the page), or open its block. */
	function pick(key: string, field: string | null, picked: boolean) {
		if (key === PAGE_SCOPE) {
			editor.view.update({ level: 'document', block: null, field: field ? pageFieldPath(field) : null, picked: picked && !!field, pop: null });
			editor.setSideHidden(false);
			if (!field) revealPageFields();
			return;
		}
		editor.openBlock(key, field, { picked: picked && !!field });
	}

	/** The open document's element was clicked: its block, its field picked (focused in the sidebar unless it's typed on the page). */
	function clickOwn(at: Extract<Claim, { kind: 'own' }>) {
		pick(at.key, at.field, true);
		// A nested path (`credits.1.name`, `buttons.0.label`) opens its field and the row that holds it; a field
		// marked without its value (no kind, Decision 10b) is picked there with its control focused.
		if (at.field && !typedOnPage(at.fieldKind, at.field)) focusSidebarField(at.key === PAGE_SCOPE ? pageFieldPath(at.field) : at.field);
	}

	/** Open another document over the page (Decision 6), its field picked; a field not typed on the page gets its control focused. */
	function openSource(at: Extract<Claim, { kind: 'source' }>, then?: () => void) {
		const typed = !!at.field && typedOnPage(at.fieldKind, at.field);
		void editor.openOver(at.ref, { field: at.field }).then(() => {
			if (at.field && !typed) {
				const session = editor.doc.get();
				focusSidebarField(session.document.kind === 'sections' ? pageFieldPath(at.field) : at.field);
			}
			then?.();
		});
	}

	/** The selected block's index on the page (the block level), or null. */
	const selectedIndex = (): number | null => {
		const view = editor.view.get();
		if (view.level !== 'block' || !view.block) return null;
		const index = editor.doc.indexOf(view.block);
		return index >= 0 ? index : null;
	};

	/** A click (or a field's focus, `focus`) on the page shown: where it goes. */
	function act(frame: PreviewFrame, el: Element, at: Claim, how: { focus: boolean }) {
		if (at.kind === 'own') {
			clickOwn(at);
			return;
		}
		if (at.kind === 'page') {
			// Decision 8: back to the page, then that click (with the field focused again if it took the caret).
			const focused = how.focus ? (at.fieldEl ?? null) : null;
			void editor.backToPage(() => {
				const again = own(el);
				if (again) clickOwn(again);
				if (focused?.isConnected && frame.document?.activeElement === focused) startTyping(frame, focused);
			});
			return;
		}
		// Decision 7: inside a block of the page that's open, the first click selects the block.
		const inBlock = at.inBlock ? blockIndexOf(at.inBlock) : null;
		if (live() && inBlock !== null && selectedIndex() !== inBlock) {
			if (how.focus) (el as HTMLElement).blur?.();
			const key = editor.doc.keyAt(inBlock);
			if (key) editor.openBlock(key);
			return;
		}
		const focused = how.focus ? (at.fieldEl ?? null) : null;
		openSource(at, () => {
			// A field typed on the page keeps the browser's caret where the click landed (Decision 7).
			if (focused?.isConnected && frame.document?.activeElement === focused) startTyping(frame, focused);
		});
	}

	/** Typing on the page starts in a plain text field that has focus (the open document's own). */
	function startTyping(frame: PreviewFrame, el: HTMLElement) {
		const at = own(el);
		if (!at?.field || at.fieldEl !== el || !el.matches('[data-cms-kind="text"]')) return;
		if (readOnly()) {
			el.blur();
			return;
		}
		typing.set({ key: at.key, field: at.field, width: frame.width });
		const view = editor.view.get();
		const field = at.key === PAGE_SCOPE ? pageFieldPath(at.field) : at.field;
		if (!holds(view, at.key) || view.field !== field) pick(at.key, at.field, true);
	}

	/** The pointer is between an element and the chip just above it (its height and gap, and a margin, on screen). */
	const nearAbove = (frame: PreviewFrame, el: Element, event: MouseEvent) => {
		const r = el.getBoundingClientRect();
		const reach = (22 + 6 + 14) / (editor.stageLayout.get()?.[frame.width].scale || 1);
		return event.clientX >= r.left - reach && event.clientX <= r.right + reach && event.clientY >= r.top - reach && event.clientY <= r.bottom;
	};

	/** The element a focus or a click already acted on: the click that follows a focus doesn't act twice. */
	let actedOn: Element | null = null;

	// ---- The page editor (on-page rich text) ----

	interface Active {
		frame: PreviewFrame;
		doc: Document;
		key: string;
		field: string;
		pe: MountedPageEditor;
		session: boolean;
	}
	/** The mounted page editor (at most one, in the iframe on screen). */
	let active: Active | null = null;
	/** The page-typed rich-text field under the pointer in the iframe on screen. */
	let pointerOn: HTMLElement | null = null;
	/** The primary button is down in the iframe, and the editor a press mounted (by focus) that its release places the caret in. */
	let pressing: { x: number; y: number } | null = null;
	let pressMounted: Active | null = null;
	/** Torn down by a morph (Decision 6): remounted after it, with this selection. */
	let resume: { key: string; field: string; width: Width; anchor: number; head: number; focused: boolean } | null = null;

	const publish = () =>
		pageEditor.set(
			active
				? { key: active.key, field: active.field, width: active.frame.width, frame: active.frame, editor: active.pe.editor, view: active.pe.view, options: active.pe.options, session: active.session }
				: null,
		);

	const richOptions = (key: string, field: string) => {
		const descriptor = descriptorOf(key, field);
		return descriptor?.kind === 'richText' ? richTextOptions(descriptor) : null;
	};

	/** Mount the page editor on a field (tearing down any other). Null where it isn't typed on the page. */
	function mountOn(frame: PreviewFrame, el: HTMLElement): Active | null {
		if (active && active.pe.el === el && !active.pe.destroyed) return active;
		const doc = frame.document;
		// Never in the hidden widths (they're laid out; they get the mirror), never read-only (Decision 10).
		if (!doc || !visible(frame) || readOnly() || !isPageRichText(el) || !el.isConnected || el.ownerDocument !== doc) return null;
		const at = own(el);
		if (!at?.field || at.fieldEl !== el) return null;
		const options = richOptions(at.key, at.field);
		if (!options) return null;
		teardown();
		const { key, field } = at;
		// One task: ProseMirror swaps the children synchronously (no await here).
		const pe = mountPageEditor(el, {
			value: valueOf(key, field),
			options,
			onChange: (value) => {
				if (!readOnly()) editor.doc.setField(key, field, value, { origin: 'page' });
			},
			onKeyDown: (event) => {
				const handled = [...editorKeys].some((handler) => handler(event));
				if (handled) claimed.add(event);
				return handled;
			},
		});
		const next: Active = { frame, doc, key, field, pe, session: false };
		active = next;
		setMounted(doc, {
			el,
			key,
			field,
			syncAttributes: (from) => pe.syncAttributes(from),
			teardownForMorph() {
				if (active !== next) return;
				resume = { key, field, width: frame.width, ...pe.selection(), focused: next.session };
				teardown({ blur: false });
			},
		});
		publish();
		return next;
	}

	/** Tear the page editor down (Decision 5): the element is left exactly as a render of the current value. */
	function teardown(options: { blur?: boolean } = {}) {
		const was = active;
		if (!was) return;
		active = null;
		if (mountedIn(was.doc)?.el === was.pe.el) setMounted(was.doc, null);
		was.pe.destroy();
		// Focus doesn't stay on a field that can't be typed in (blur the element, never Tiptap's commands.blur()).
		if (options.blur !== false && was.doc.activeElement === was.pe.el) was.pe.el.blur();
		const now = typing.get();
		if (now && now.key === was.key && now.field === was.field && now.width === was.frame.width) typing.set(null);
		publish();
	}

	/** A session starts: focus reached the editor (a click, a tap, Tab, or a remount after a morph). */
	function startSession(frame: PreviewFrame, a: Active) {
		a.session = true;
		typing.set({ key: a.key, field: a.field, width: frame.width });
		publish();
		const view = editor.view.get();
		const field = a.key === PAGE_SCOPE ? pageFieldPath(a.field) : a.field;
		if (!holds(view, a.key) || view.field !== field) pick(a.key, a.field, true);
	}

	function attach(frame: PreviewFrame): () => void {
		const doc = frame.document!;
		const on = <K extends keyof DocumentEventMap>(type: K, fn: (event: DocumentEventMap[K]) => void, capture = false) => {
			doc.addEventListener(type, fn as EventListener, capture);
			return () => doc.removeEventListener(type, fn as EventListener, capture);
		};
		const offs = [
			on('mousemove', (event) => {
				if (!visible(frame) || !clickable()) return;
				const el = elementOf(event.target);
				// On the layer (a chip, the formatting bar): what's hovered stays, so its chip can be reached.
				if (el && inLayer(el)) return;
				const c = el ? claim(el) : null;
				// The page under an opened document gets no hover (Decision 8): it's shown, not edited.
				const next: PageHover | null =
					c?.kind === 'own'
						? { block: c.ctx.kind === 'block' ? c.ctx.index : -1, field: c.field, key: c.key, fieldEl: c.fieldEl, source: null }
						: c?.kind === 'source'
							? { block: -1, field: c.field, key: null, fieldEl: c.fieldEl, source: { ref: c.ref, root: c.root, field: c.field, fieldEl: c.fieldEl, inBlock: c.inBlock ? blockIndexOf(c.inBlock) : null } }
							: null;
				const now = hover.get();
				// On the way from a hovered item up to its "Edit … →" chip (overlays/source-marks.ts): it stays hovered.
				// Not once that item's document is the one open (a click opened it over the page): it's the open
				// document's own now, so its rich text mounts under the pointer.
				if (now?.source && !sameDoc(now.source.ref, editor.doc.get().ref) && next?.source?.root !== now.source.root && now.source.root.isConnected && nearAbove(frame, now.source.root, event)) return;
				if (now?.block !== next?.block || now?.field !== next?.field || now?.fieldEl !== next?.fieldEl || now?.source?.root !== next?.source?.root || now?.key !== next?.key) hover.set(next);
				const at = c?.kind === 'own' ? c : null;
				// The page editor is mounted before the first press lands (Decision 5); never mid-press.
				const rich = at?.field && typedOnPage(at.fieldKind, at.field) && isPageRichText(at.fieldEl) ? at.fieldEl : null;
				pointerOn = rich;
				if (rich) {
					// While a session is on in this frame the pointer doesn't matter (Decision 5): the other field mounts on its focus.
					const session = active?.session && active.frame === frame;
					if (event.buttons === 0 && !session) mountOn(frame, rich);
				} else if (active && active.frame === frame && !active.session) teardown();
			}),
			// A press that mounts the editor by focus (the pointer crossed the field while another session was on,
			// so mousemove left it alone): the browser put its caret in the render's text, which the mount replaced.
			// When the press is released the selection goes from where it was pressed to where it was
			// released: a caret for a click, the range for a drag.
			on(
				'mousedown',
				(event) => {
					pressing = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
					pressMounted = null;
				},
				true,
			),
			on(
				'mouseup',
				(event) => {
					const a = pressMounted;
					const from = pressing;
					pressing = null;
					pressMounted = null;
					if (!a || !from || active !== a || a.pe.destroyed) return;
					const head = a.pe.view.posAtCoords({ left: event.clientX, top: event.clientY });
					const anchor = a.pe.view.posAtCoords({ left: from.x, top: from.y }) ?? head;
					if (head && anchor) a.pe.select(anchor.pos, head.pos);
				},
				true,
			),
			on('mouseleave', () => {
				hover.set(null);
				if (elsewhere.get()?.width === frame.width) elsewhere.set(null);
				pointerOn = null;
				if (active && active.frame === frame && !active.session) teardown();
			}),
			on('click', (event) => {
				if (!visible(frame) || !clickable()) return;
				const el = elementOf(event.target);
				if (!el || inLayer(el)) return;
				const acted = actedOn;
				actedOn = null;
				const at = claim(el);
				// Decision 13: the frame a site draws itself (follow-links.ts has already followed its links).
				if (!at) {
					elsewhere.set(live() && inUnmarkedFrame(el) ? { width: frame.width, el: el as HTMLElement } : null);
					return;
				}
				elsewhere.set(null);
				// Its focus already went there (a field typed on the page: focusin, below).
				if (acted && at.fieldEl && acted === at.fieldEl && at.kind !== 'own') return;
				act(frame, el, at, { focus: false });
			}),
			on('focusin', (event) => {
				const el = elementOf(event.target);
				// Focus moving into the overlay layer (the formatting bar, the link popover's search) keeps the session on.
				if (el && inLayer(el)) {
					if (active && active.frame === frame && !active.session) {
						active.session = true;
						publish();
					}
					return;
				}
				if (isPageRichText(el)) {
					if (!live() && !over()) return;
					// Another document's (or, over a page, the page's): it opens there first (Decisions 7, 8).
					const c = claim(el);
					if (c && c.kind !== 'own') {
						actedOn = el;
						if (visible(frame)) act(frame, el, c, { focus: false });
						el.blur();
						return;
					}
					if (readOnly()) {
						el.blur();
						return;
					}
					let a = active && active.pe.el === el ? active : null;
					if (!a) {
						// Mounted by focus (a tap, Tab): the caret goes where the browser put it.
						const point = pointInField(el);
						a = mountOn(frame, el);
						if (!a) return;
						if (pressing) pressMounted = a;
						// ProseMirror missed this focus event (it wasn't there yet): give it one.
						const win = frame.window as (Window & typeof globalThis) | null;
						if (win) a.pe.view.dom.dispatchEvent(new win.FocusEvent('focus'));
						const pos = point ? positionOf(a.pe.view, point) : null;
						if (pos !== null) a.pe.select(pos);
					}
					startSession(frame, a);
					return;
				}
				if (!el?.matches('[data-cms-kind="text"]') || (!live() && !over())) return;
				const c = claim(el);
				if (c && c.kind !== 'own') {
					// One click in the frame (Decision 7), or back to the page (Decision 8): the caret stays where it landed.
					actedOn = el;
					if (visible(frame)) act(frame, el, c, { focus: true });
					return;
				}
				startTyping(frame, el as HTMLElement);
			}),
			on('focusout', (event) => {
				const el = elementOf(event.target);
				if (active && active.frame === frame && el && (el === active.pe.el || inLayer(el))) {
					const to = elementOf(event.relatedTarget);
					// Between the text and the layer (the bar, the popover's search): still one session.
					if (to && to.ownerDocument === doc && (active.pe.el.contains(to) || inLayer(to))) return;
					active.session = false;
					const now = typing.get();
					if (now && now.key === active.key && now.field === active.field && now.width === frame.width) typing.set(null);
					publish();
					if (pointerOn !== active.pe.el) teardown({ blur: false });
					return;
				}
				const now = typing.get();
				if (!now || !el?.matches('[data-cms-kind="text"]') || now.width !== frame.width) return;
				typing.set(null);
			}),
			on('input', (event) => {
				const el = elementOf(event.target)?.closest('[data-cms-kind="text"]');
				if (!el || readOnly()) return;
				const at = own(el);
				if (!at?.field || at.fieldEl !== el) return;
				editor.doc.setField(at.key, at.field, fieldText(el, isMultiline(at.key, at.field)), { origin: 'page' });
			}),
			on('beforeinput', (event) => {
				const el = elementOf(event.target)?.closest('[data-cms-kind="text"]');
				if (!el) return;
				const at = own(el);
				// Read-only, or not the open document's (the page under it, another document still opening): nothing typed.
				if (readOnly() || !at?.field || at.fieldEl !== el) {
					event.preventDefault();
					return;
				}
				if (isMultiline(at.key, at.field)) return;
				if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') event.preventDefault();
			}),
			on('paste', (event) => {
				const el = elementOf(event.target)?.closest('[data-cms-kind="text"]');
				if (!el) return;
				const at = own(el);
				if (readOnly() || !at?.field || at.fieldEl !== el) {
					event.preventDefault();
					return;
				}
				if (isMultiline(at.key, at.field)) return;
				const text = event.clipboardData?.getData('text/plain');
				if (text === undefined) return;
				event.preventDefault();
				doc.execCommand('insertText', false, text.replace(/\s*\n\s*/g, ' '));
			}),
			on('keydown', (event) => {
				const el = elementOf(event.target);
				const field = el?.closest<HTMLElement>('[data-cms-kind="text"]');
				const rich = el && active && active.frame === frame && active.pe.el.contains(el) ? active : null;
				// ⌘\ hides or shows the sidebar from the page too (App.tsx has it for the editor's own window).
				if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && (event.key === '\\' || event.code === 'Backslash')) {
					event.preventDefault();
					editor.setSideHidden(editor.ui.get().side !== 'hidden');
					return;
				}
				// ⌘K opens the document switcher from the page too (App.tsx has it for the editor's own window).
				// In a rich-text field the rich-text bar claims it first, for the link popover.
				if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
					if (claimed.has(event) || event.defaultPrevented) return;
					event.preventDefault();
					editor.setPop(editor.view.get().pop === 'switcher' ? null : 'switcher');
					return;
				}
				if (event.key === 'Escape') {
					// The bar's menu or link popover closed first (rich-text-bar.ts): then the field, then the level.
					if (claimed.has(event)) return;
					event.preventDefault();
					if (field) field.blur();
					// Leave the rich-text field (view.dom.blur(): Tiptap's commands.blur() clears /admin's selection).
					else if (rich) rich.pe.view.dom.blur();
					else editor.goUp();
					return;
				}
				if (event.key === 'Enter' && field) {
					const at = own(field);
					if (at?.field && !isMultiline(at.key, at.field)) {
						event.preventDefault();
						field.blur();
					}
				}
			}),
		];
		return () => offs.forEach((off) => off());
	}

	// A hook's cleanup runs before its next run for that frame (after every morph too), so
	// listeners are kept per document instead: attached once when a frame's document loads.
	const attached = new WeakSet<Document>();
	const detachers: (() => void)[] = [];
	stops.push(
		driver.registerFrameHook((frame) => {
			const doc = frame.document;
			if (!doc || attached.has(doc)) return;
			attached.add(doc);
			detachers.push(attach(frame));
		}),
	);
	stops.push(() => detachers.forEach((detach) => detach()));

	// After a morph: a torn-down (or detached) page editor is remounted when the session
	// or the pointer is still there (Decision 6); a reloaded document drops it.
	stops.push(
		driver.registerFrameHook((frame, reason) => {
			const doc = frame.document;
			if (active && active.frame.width === frame.width && (reason === 'load' || active.doc !== doc || !active.pe.el.isConnected)) teardown({ blur: false });
			if (!doc || reason !== 'morph') return;
			const r = resume && resume.width === frame.width ? resume : null;
			if (r) resume = null;
			const pointer = pointerOn && pointerOn.isConnected && pointerOn.ownerDocument === doc ? pointerOn : null;
			if (r && (r.focused || pointer)) {
				const el = fieldElements(doc, ctxsOf(r.key), r.field, 'richText')[0] ?? null;
				const a = el ? mountOn(frame, el) : null;
				if (a) a.pe.select(r.anchor, r.head, r.focused);
				return;
			}
			if (pointer && !active) mountOn(frame, pointer);
		}),
	);

	function reveal(index: number | readonly Ctx[], field?: string | null, options: { instant?: boolean } = {}) {
		const frame = driver?.frames().find((f) => f.width === editor.view.get().width);
		const doc = frame?.document;
		const win = frame?.window;
		if (!doc || !win) return;
		const at: readonly Ctx[] = typeof index === 'number' ? [{ kind: 'block', index }] : index;
		const root = contextRoots(doc, at)[0];
		const el = (field && root && (fieldElements(doc, at, field)[0] ?? root.querySelector<HTMLElement>(`[data-cms-field="${CSS.escape(field)}"]`))) || root;
		// A skipped block has no element, only its comment (skipped.ts): scroll to where it would be.
		const blockAt = at.find((c) => c.kind === 'block');
		const anchor = el || blockAt?.kind !== 'block' ? null : skippedAnchor(doc, blockAt.index);
		if (!el && !anchor) return;
		const r = el ? el.getBoundingClientRect() : { top: skippedTop(anchor!), bottom: skippedTop(anchor!) };
		const vh = win.innerHeight;
		if (!options.instant && r.top >= 40 && r.bottom <= vh - 40) return;
		if (options.instant && r.top >= 0 && r.top <= vh - 40) return;
		const scale = editor.stageLayout.get()?.[frame!.width].scale ?? 1;
		const y = win.scrollY + r.top - Math.min(vh * 0.2, 120 / scale);
		win.scrollTo({ top: Math.max(0, y), behavior: options.instant || reducedMotion() ? 'auto' : 'smooth' });
	}

	// Follow the sidebar: a block or field picked there scrolls into view; leaving the block ends typing.
	stops.push(
		editor.view.subscribe((view, previous) => {
			const now = typing.get();
			if (now && !holds(view, now.key)) {
				const frame = driver.frames().find((f) => f.width === now.width);
				const focused = frame?.document?.activeElement as HTMLElement | null | undefined;
				focused?.blur?.();
				typing.set(null);
			}
			if (view.picked || (!live() && !over())) return;
			const widthChanged = view.width !== previous.width;
			if (view.block === previous.block && view.field === previous.field && previous.level === view.level && !widthChanged) return;
			// A page field picked in Page details (`page.<path>`), or a block's (a form's) field.
			const pageField = view.level === 'document' && view.field?.startsWith(PAGE_PREFIX) ? view.field.slice(PAGE_PREFIX.length) : null;
			const key = pageField !== null ? PAGE_SCOPE : editor.fieldsOpen(view) ? view.block : null;
			if (!key) return;
			const at = ctxsOf(key);
			if (at.length) requestAnimationFrame(() => reveal(at, pageField ?? view.field, { instant: widthChanged }));
		}),
	);
	stops.push(editor.view.subscribe((view, previous) => view.width !== previous.width && hover.set(null)));
	// The page editor goes when the width changes or its block's level closes (Decision 5).
	stops.push(
		editor.view.subscribe((view, previous) => {
			if (!active) return;
			if (view.width !== previous.width) {
				pointerOn = null;
				teardown();
				return;
			}
			const wasOpen = holds(previous, active.key);
			const isOpen = holds(view, active.key);
			if (wasOpen && !isOpen) teardown();
		}),
	);
	// A change from elsewhere reaches the mounted editor (Decision 8: without an update, its own echo
	// ignored); another document opening, or its block going, tears it down.
	stops.push(
		editor.doc.subscribe((_session, change) => {
			if (!active) return;
			if (change.kind === 'load') {
				teardown();
				return;
			}
			if (active.key !== PAGE_SCOPE && !editor.doc.block(active.key)) {
				teardown();
				return;
			}
			active.pe.setValue(valueOf(active.key, active.field));
		}),
	);
	// Going read-only mid-typing (a lock arrived, signed out): leave the field on the page.
	stops.push(
		editor.access.subscribe((access) => {
			if (!access.readOnly) return;
			hover.set(null);
			// Decision 10: the page editor goes at once; the value already stored stays.
			resume = null;
			teardown();
			const now = typing.get();
			if (!now) return;
			const frame = driver.frames().find((f) => f.width === now.width);
			(frame?.document?.activeElement as HTMLElement | null | undefined)?.blur?.();
			typing.set(null);
		}),
	);

	// The elsewhere chip goes when anything else happens: another document, a pick, a width.
	stops.push(editor.view.subscribe(() => elsewhere.get() && elsewhere.set(null)));
	stops.push(editor.doc.subscribe((_s, change) => change.kind === 'load' && elsewhere.set(null)));

	// Over a page, its own blocks are shown, not edited: no text caret on them (the mockup's `.site.over`).
	const markOver = () => {
		const on = over();
		for (const frame of driver.frames()) {
			const root = frame.document?.documentElement;
			if (!root) continue;
			if (on) root.setAttribute('data-cms-over', '');
			else root.removeAttribute('data-cms-over');
			let style = frame.document!.getElementById(OVER_STYLE_ID);
			if (!style) {
				style = frame.document!.createElement('style');
				style.id = OVER_STYLE_ID;
				style.textContent = OVER_CSS;
				(frame.document!.head ?? root).appendChild(style);
			}
		}
	};
	stops.push(driver.registerFrameHook(() => markOver()));
	stops.push(editor.previewStatus.subscribe(markOver));
	stops.push(editor.over.subscribe(markOver));
	stops.push(editor.doc.state.subscribe(markOver));
	stops.push(editor.view.subscribe((v, p) => v.opening !== p.opening && markOver()));

	const pageEdit: PageEdit = {
		typing,
		pageEditor,
		hover,
		elsewhere,
		onEditorKey(handler) {
			editorKeys.add(handler);
			return () => editorKeys.delete(handler);
		},
		claimKey(event) {
			claimed.add(event);
		},
		reveal,
		destroy() {
			teardown();
			for (const stop of stops) stop();
		},
	};
	made.set(editor, pageEdit);
	return pageEdit;
}
