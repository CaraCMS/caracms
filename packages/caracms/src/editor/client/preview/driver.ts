/**
 * The preview driver (Decision 13, as M1 proved it): three same-origin iframes of
 * the preview route at 1440, 768 and 375, driven from /admin. The preview page
 * itself carries no editor script.
 *
 * - **One render per change, morphed into all three**: the document is POSTed to
 *   the preview route (`{ version, collection, document }`) and the HTML that comes
 *   back is morphed into each iframe's body with idiomorph. **Never `<head>`**:
 *   stylesheets and fonts would refetch and the preview would flicker.
 * - **Latest edit wins** (render-sequencer.ts, lifted from M1): at most one render
 *   in flight, no debounce, older responses dropped, and on-page text re-applied
 *   after a response that predates it.
 * - **Each iframe's selection is saved and restored around every morph**
 *   (selection.ts), so a caret on the page survives a re-render wherever focus is.
 * - **The phone warning** reads the phone iframe's computed lockup sizes after every
 *   morph and when it loads (warnings.ts; M1 → E7) into `status.warnings`.
 * - **Opening another document loads the frames afresh** (M8 trial, item 8): each frame
 *   navigates to the preview route's GET for it (`location.replace`, no history entry), so
 *   the page's own scripts run as on a public load (a morph would keep the old page's
 *   scripts and never run the new one's). The browser holds the old page on screen until
 *   the new one paints. Once all three have loaded, the frames show the document as the
 *   store has it (the editor's copy, since it was just read from there): nothing is
 *   rendered or morphed, so what the page's scripts did stays. Edits made while they
 *   load, or unsent edits brought back from the browser's storage (`adopted`), are
 *   rendered and morphed in once they have. Edits within a document are always morphed.
 *   Opening the document the frames already hold (back from Site Settings, a refresh)
 *   morphs as before. A failed render keeps the last good preview and sets `status.failed`.
 * - **A failed load is not the page** (M8 review): a frame that navigated to an error page
 *   (a 404 when the file went from disk, a 401, a 500) holds no `data-caracms-preview` on its
 *   `<html>` (the editor's middleware marks the preview route's pages). Once all three have
 *   loaded, if any is such a page: a 401 (asked again by a GET, only then and only in live
 *   mode) goes to `onSignedOut` as a render's does; otherwise the frames go back to the last
 *   page they loaded well (`status.showing`) and `status.failed` is set, as a failed render
 *   does. If that load fails too, they stay as they are, failed. Nothing is ever rendered or
 *   morphed into an error page: a render asked for while one is showing (Try again, an
 *   edit) loads the frames afresh with the open document instead.
 * - Links and forms in the preview don't navigate it. A click on a link can open its
 *   document in the editor instead (follow-links.ts).
 *
 * ## For Phases 3 and 4 (the overlays, click to edit, typing on the page, the
 * block list's hover link)
 *
 *   frames()                          the three PreviewFrames (desktop, tablet, phone)
 *   frame(width)                      one of them
 *   onLoad(fn)                        a frame's document loaded (the first time, or reloaded)
 *   onMorph(fn)                       a render was morphed into all three
 *   registerFrameHook(hook)           hook(frame, 'load' | 'morph') for each frame, on load and
 *                                     after every morph; a returned function is called before
 *                                     the next run for that frame (and on unregister)
 *   mirrorText(block, field, text, except?)   put typed text into the other iframes (`block`: an index, or contexts: markers.ts)
 *   status                            { painted, failed, showing, opening, warnings }
 *
 * **For the site's own scripts** (fitted text, carousels, search boxes, motion), the one
 * public hook: after every morph into a frame, that frame's `document` gets a
 * `CustomEvent('caracms:rendered', { detail: { reason: 'morph' } })`, made from the frame's
 * own window (so `instanceof CustomEvent` holds there), once the morph, the selection
 * restore, the driver's hooks and the onMorph listeners have run. It doesn't bubble and
 * never leaves the frame; public pages never get it. **Not fired on load**: a (re)loaded
 * document runs the site's scripts itself.
 *
 *   document.addEventListener('caracms:rendered', () => setUpCarousels())
 *
 * **A document open over a page** (edit in context, Decisions 8 and 9; `options.over`): the
 * frames keep the page (`status.showing`), and every render is the page with the opened
 * document's copy on top: `{ version, collection, path, overlay: { collection, path, document } }`,
 * the page as kept (the editor keeps its pending edits before opening anything over it). Site
 * Settings is always over a page (Home when /admin/settings is the first address); without one
 * it renders nothing and the last page stays. Going back to the page renders it as before.
 *
 * Text typed on the page goes through the document store with `origin: 'page'`
 * (document-store.ts): the driver then mirrors it into the other iframes instead of
 * rendering it, and counts it as a 'local' change for latest-wins. Plain text and,
 * since on-page rich text (its Decision 7), a top-level rich-text field: its value is
 * mirrored as the render's HTML (`richTextHtml`).
 *
 * **A page editor mounted in an iframe (page-editor-registry.ts) is never written by
 * the driver:** the mirror and the re-apply skip it, and the morph leaves it alone
 * only when idiomorph pairs it with its own field in the render; paired with anything
 * else (a same-tag sibling the render put before it), it's torn down right there,
 * inside the callback, and the morph goes on (Decision 6). With focus in the editor,
 * that iframe is morphed without `ignoreActive` (which would skip the editor before
 * the rule runs); the editor is the only element it could protect there.
 */
import { Idiomorph } from 'idiomorph';
import type { DocumentStore } from '../state/document-store.ts';
import { createStore, type Store } from '../state/store.ts';
import { ENDPOINTS, PREVIEW_MARK, TRUE_WIDTH, WIDTHS, sameDoc, type DocRef, type EditorSite, type Width } from '../../types.ts';
import { createSequencer, type Sequencer } from './render-sequencer.ts';
import { fieldText, shownText, writeFieldText } from './field-text.ts';
import { restoreSelection, saveSelection } from './selection.ts';
import { readLockups, type LockupWarning } from './warnings.ts';
import { ACTIVITY_EVENTS } from '../state/live.ts';
import { fieldElements, type Ctx } from './markers.ts';
import { ownCtxs } from './places.ts';
import { PAGE_SCOPE } from '../state/document-store.ts';
import { mountedIn, writeRichText } from './page-editor-registry.ts';
import { fieldAt, getAtPath, isKeyPath, richTextOptions, type Fields, type RichTextField } from '../../../fields.ts';
import { fieldsOfBlock } from '../state/schema.ts';

export interface PreviewFrame {
	readonly width: Width;
	readonly trueWidth: number;
	readonly iframe: HTMLIFrameElement;
	/** The frame's document once it has loaded the preview, else null. */
	readonly document: Document | null;
	readonly window: Window | null;
}

export interface PreviewStatus {
	/** The first paint is done: the stage can show the preview (until then it's a still surface). */
	painted: boolean;
	/** The latest render failed: the last good preview stays, and the bar says so. */
	failed: boolean;
	/** The document the preview shows. It lags the sidebar while another document opens. */
	showing: DocRef;
	/** Another document is being rendered for the first time (the old preview is held meanwhile). */
	opening: DocRef | null;
	/** Lockups as the phone iframe computed them (warnings.ts). */
	warnings: LockupWarning[];
}

export type FrameHook = (frame: PreviewFrame, reason: 'load' | 'morph') => void | (() => void);

export interface MorphEvent {
	/** The document version morphed in. */
	version: number;
	/** The first render of a newly opened document. */
	opened: boolean;
	frames: PreviewFrame[];
}

export interface PreviewDriver {
	readonly status: Store<PreviewStatus>;
	/** The Stage hands over its three iframes once mounted. Returns a detach. */
	attach(iframes: Record<Width, HTMLIFrameElement>): () => void;
	frames(): PreviewFrame[];
	frame(width: Width): PreviewFrame;
	onLoad(listener: (frame: PreviewFrame) => void): () => void;
	onMorph(listener: (event: MorphEvent) => void): () => void;
	/** A render (or a load) failed: "Preview not updated", the page keeping its last good render. */
	onFail(listener: () => void): () => void;
	registerFrameHook(hook: FrameHook): () => void;
	/** Put text typed on the page into the other iframes (`except`: the one it was typed in). */
	mirrorText(block: number | readonly Ctx[], field: string, text: string, except?: Document | null): void;
	/** Render the latest version now (the preview-trouble popover's Try again, and a block state chosen in the switch). */
	retry(): void;
	/** The preview route's URL for a document's file (an iframe's src). */
	srcFor(ref: DocRef): string;
}

export function previewSrc(ref: DocRef): string {
	return `${ENDPOINTS.preview}?collection=${encodeURIComponent(ref.collection)}&path=${encodeURIComponent(ref.path)}`;
}

interface FrameState {
	frame: PreviewFrame;
	loaded: boolean;
	/** Its document is a preview (PREVIEW_MARK), not an error page. */
	good: boolean;
	cleanups: Map<FrameHook, () => void>;
	detach: (() => void) | null;
}

export function createPreviewDriver(options: {
	store: DocumentStore;
	site: Pick<EditorSite, 'blocks' | 'collections'>;
	/** The page the preview shows when the first document opened has none of its own (Site Settings, M5a). */
	home?: DocRef;
	/** Edit in context: the page the open document is shown over, or null (editor.ts → `over`). Read on every load and render. */
	over?: () => DocRef | null;
	/**
	 * Review gaps (Decision 7): the block state to draw, `{ block, name }` (the block's index among the
	 * shown page's own blocks), or null. Read on every render (the POST's `state`) and every fresh load
	 * (the GET's `&state=`); choosing one asks for a render with `retry()`.
	 */
	state?: () => { block: number; name: string } | null;
	fetch?: typeof fetch;
	/**
	 * Live mode: a render answered 401 (the session ended, or the person was removed).
	 * Told the answer's body; the render is dropped **without** "Preview not updated",
	 * since the editor's signed-out state already says why (the mockup's
	 * #signed-out-edit). The next render once signed in again goes as usual.
	 */
	onSignedOut?: (body: unknown) => void;
	/** Live mode: someone typed, clicked or scrolled in a preview (the lock's idle rule, Take over). */
	onActivity?: () => void;
}): PreviewDriver {
	const { store, site } = options;
	const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
	const overPage = () => options.over?.() ?? null;
	/** Site Settings has no page of its own: shown over none, nothing is rendered for it (M5a). */
	const pageless = () => store.get().document.kind === 'settings' && !overPage();
	/** The page the frames show for the open document: the page it's over, else its own. */
	const target = (): DocRef => overPage() ?? store.get().ref;
	const status = createStore<PreviewStatus>({ painted: false, failed: false, showing: overPage() ?? (pageless() && options.home ? options.home : store.get().ref), opening: null, warnings: [] });
	const frames = new Map<Width, FrameState>();
	const loadListeners = new Set<(frame: PreviewFrame) => void>();
	const morphListeners = new Set<(event: MorphEvent) => void>();
	const failListeners = new Set<() => void>();
	/** "Preview not updated", told to the onFail listeners. */
	const failed = (patch: Partial<PreviewStatus> = {}) => {
		status.update({ failed: true, opening: null, ...patch });
		for (const listener of [...failListeners]) listener();
	};
	const hooks = new Set<FrameHook>();

	/** A new generation per opened document; responses from an older one are dropped. */
	let generation = 0;
	/** The generation the iframes show. 0: the file, as the iframes' first GET rendered it. */
	let shownGeneration = 0;
	let seq: Sequencer = createSequencer(0);
	/** A render was asked for before the frames were ready. */
	let deferred = false;
	/** The page document the frames were loaded for (their GET); another one loads them afresh (item 8). */
	let loadedRef: DocRef = status.get().showing;
	/** The generation whose fresh load needs no render once all three frames have loaded, else null. */
	let freshLoad: number | null = null;
	/** The page the frames last loaded as a preview, all three; null before the first. */
	let lastGood: DocRef | null = null;
	/** The frames are going back to `lastGood` after a failed load. */
	let recovering = false;

	const ready = () => frames.size === WIDTHS.length && [...frames.values()].every((f) => f.loaded);
	/** Some frame holds an error page (a failed load), not a preview. */
	const someBad = () => [...frames.values()].some((f) => f.loaded && !f.good);
	const isPreviewDocument = (doc: Document) => doc.documentElement?.hasAttribute(PREVIEW_MARK) === true;
	const list = () => WIDTHS.map((w) => frames.get(w)?.frame).filter((f): f is PreviewFrame => !!f);

	function runHooks(state: FrameState, reason: 'load' | 'morph', only?: FrameHook) {
		for (const hook of only ? [only] : hooks) {
			state.cleanups.get(hook)?.();
			state.cleanups.delete(hook);
			try {
				const cleanup = hook(state.frame, reason);
				if (typeof cleanup === 'function') state.cleanups.set(hook, cleanup);
			} catch (error) {
				console.error('[caracms] a preview hook failed:', error);
			}
		}
	}

	function readWarnings() {
		const phone = frames.get('phone');
		const doc = phone?.frame.document;
		const win = phone?.frame.window;
		if (!phone?.loaded || !doc || !win) return;
		status.update({ warnings: readLockups(doc, win) });
	}

	/**
	 * Keep the preview from navigating away: links and forms do nothing. Review gaps (Decision 12): a
	 * form's controls take no focus there (so a click is the editor's: its placeholder's control in
	 * the sidebar), a select doesn't open and a files field doesn't ask for files.
	 */
	function guard(doc: Document): () => void {
		const CONTROL = 'form[data-caracms-form] :is(input, textarea, select)';
		const onClick = (event: Event) => {
			const target = event.target as Element | null;
			if (target?.closest?.('a[href]') || target?.closest?.('form[data-caracms-form] input[type="file"]')) event.preventDefault();
		};
		const onDown = (event: Event) => {
			if ((event.target as Element | null)?.closest?.(CONTROL)) event.preventDefault();
		};
		const onSubmit = (event: Event) => event.preventDefault();
		const onActivity = () => options.onActivity?.();
		doc.addEventListener('click', onClick, true);
		doc.addEventListener('mousedown', onDown, true);
		doc.addEventListener('submit', onSubmit, true);
		for (const type of ACTIVITY_EVENTS) doc.addEventListener(type, onActivity, { capture: true, passive: true });
		return () => {
			doc.removeEventListener('click', onClick, true);
			doc.removeEventListener('mousedown', onDown, true);
			doc.removeEventListener('submit', onSubmit, true);
			for (const type of ACTIVITY_EVENTS) doc.removeEventListener(type, onActivity, { capture: true });
		};
	}

	async function maybePaint() {
		if (status.get().painted || !ready() || shownGeneration !== generation) return;
		// Fonts are `font-display: block`: wait for them so the first paint isn't blank text (capped).
		const doc = frames.get('desktop')?.frame.document;
		await Promise.race([doc?.fonts?.ready, new Promise((resolve) => setTimeout(resolve, 1500))]);
		status.update({ painted: true });
	}

	function onFrameLoaded(state: FrameState) {
		const doc = state.frame.document;
		if (!doc || doc.location.href === 'about:blank') return;
		const again = state.loaded;
		state.loaded = true;
		state.good = isPreviewDocument(doc);
		state.detach?.();
		state.detach = guard(doc);
		if (state.good) {
			runHooks(state, 'load');
			for (const listener of [...loadListeners]) listener(state.frame);
			if (state.frame.width === 'phone') readWarnings();
		}
		if (!ready()) return;
		if (someBad()) {
			void onFailedLoad();
			return;
		}
		lastGood = loadedRef;
		if (recovering) {
			// Back on the last good page after a failed load: it stays, failed, until Try again or an edit.
			recovering = false;
			freshLoad = null;
			if (deferred) {
				deferred = false;
				request('render');
			}
			void maybePaint();
			return;
		}
		if (freshLoad === generation && !deferred && !again) {
			// Item 8: the frames loaded the document as the store has it; the page's scripts have run. Nothing to morph.
			freshLoad = null;
			shownGeneration = generation;
			status.update({ failed: false, showing: target(), opening: null });
			void maybePaint();
			return;
		}
		freshLoad = null;
		if (again || deferred || generation !== shownGeneration) {
			// A frame reloaded (Vite, say) shows the file; bring all three to the editor's copy.
			deferred = false;
			request('render');
		}
		void maybePaint();
	}

	/**
	 * All three frames have loaded and one holds an error page (header: a failed load is not the
	 * page). A 401 goes to `onSignedOut`; otherwise back to the last good page once, failed.
	 */
	async function onFailedLoad() {
		const gen = generation;
		const failedRef = loadedRef;
		console.warn('[caracms] the preview could not be loaded:', docLabel(failedRef));
		if (options.onSignedOut) {
			// The frame can't tell its answer's status: ask again, only on this path.
			try {
				const response = await doFetch(previewSrc(failedRef), { headers: { Accept: 'application/json' } });
				if (response.status === 401) {
					const said = (await response.json().catch(() => ({}))) as unknown;
					if (gen !== generation || !sameDoc(failedRef, loadedRef)) return;
					recovering = false;
					status.update({ opening: null });
					options.onSignedOut(said);
					return;
				}
			} catch {
				/* unreachable: treated as any other failure */
			}
			if (gen !== generation || !sameDoc(failedRef, loadedRef) || !someBad()) return;
		}
		if (!recovering && lastGood && !sameDoc(lastGood, failedRef)) {
			recovering = true;
			freshLoad = null;
			loadedRef = lastGood;
			failed({ showing: lastGood });
			for (const state of frames.values()) navigate(state, lastGood);
			return;
		}
		recovering = false;
		freshLoad = null;
		failed();
	}

	const docLabel = (ref: DocRef) => `${ref.collection}/${ref.path}`;

	/** Load a frame afresh with a document's preview (item 8): its scripts run as on a public load. */
	function navigate(state: FrameState, ref: DocRef) {
		state.loaded = false;
		state.good = false;
		const shown = options.state?.() ?? null;
		const src = `${previewSrc(ref)}${shown ? `&state=${shown.block}:${encodeURIComponent(shown.name)}` : ''}`;
		try {
			state.frame.window!.location.replace(src);
		} catch {
			state.frame.iframe.src = src;
		}
	}

	function request(kind: 'render' | 'local') {
		if (pageless()) return;
		if (!ready()) {
			// Either kind: an edit typed on the page while the frames load is rendered once they have (header).
			deferred = true;
			return;
		}
		if (someBad()) {
			// Never morph into an error page: load the open document afresh, then render the editor's copy.
			const ref = target();
			loadedRef = ref;
			freshLoad = null;
			deferred = true;
			recovering = false;
			if (!sameDoc(status.get().showing, ref)) status.update({ opening: ref });
			for (const state of frames.values()) navigate(state, ref);
			return;
		}
		const { send } = seq.change(kind);
		if (send !== null) void render(send, generation, seq);
	}

	async function render(version: number, gen: number, sequencer: Sequencer) {
		const { ref: own } = store.get();
		const page = overPage();
		const ref = page ?? own;
		const state = options.state?.() ?? null;
		const body = JSON.stringify({
			...(page
				? { version, collection: page.collection, path: page.path, overlay: { collection: own.collection, path: own.path, document: store.wire() } }
				: { version, collection: own.collection, path: own.path, document: store.wire() }),
			...(state ? { state } : {}),
		});
		let html: string;
		let echoed: number | null;
		try {
			const response = await doFetch(ENDPOINTS.preview, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
			if (response.status === 401 && options.onSignedOut) {
				const said = (await response.json().catch(() => ({}))) as unknown;
				if (gen !== generation) return;
				sequencer.failure(version);
				options.onSignedOut(said);
				return;
			}
			if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 300)}`);
			const header = response.headers.get('X-Preview-Version');
			echoed = header === null || header.trim() === '' || Number.isNaN(Number(header)) ? null : Number(header);
			html = await response.text();
		} catch (error) {
			if (gen !== generation) return;
			console.warn('[caracms] the preview could not be rendered:', error);
			sequencer.failure(version);
			failed();
			return;
		}
		if (gen !== generation) return; // another document has opened since
		if (echoed !== version) {
			sequencer.response(version, echoed);
			failed();
			return;
		}
		const action = sequencer.response(version, echoed);
		if (action.send !== null) void render(action.send, gen, sequencer);
		if (!action.apply) return;
		const opened = shownGeneration !== gen;
		// A document opened over the page the frames already show (edit in context) keeps its scroll.
		const moved = !sameDoc(status.get().showing, ref);
		const morphed = morphAll(html, action.reapplyLocal);
		if (opened && moved) {
			shownGeneration = gen;
			for (const f of list()) {
				f.window?.scrollTo(0, 0);
				try {
					f.window?.history.replaceState(null, '', previewSrc(ref));
				} catch {
					/* a reload would show the old document's file; harmless */
				}
			}
		}
		status.update({ failed: false, showing: ref, opening: null });
		readWarnings();
		for (const state of frames.values()) runHooks(state, 'morph');
		const event: MorphEvent = { version, opened, frames: list() };
		for (const listener of [...morphListeners]) listener(event);
		for (const state of morphed) announceRendered(state);
		void maybePaint();
	}

	/** The site-facing hook (header): `caracms:rendered` on a frame's document after a morph. */
	function announceRendered(state: FrameState) {
		const doc = state.frame.document;
		const win = state.frame.window as (Window & { CustomEvent: typeof CustomEvent }) | null;
		if (!doc || !win) return;
		try {
			// A throwing listener is reported by the frame and doesn't reach here; the try is for a
			// frame torn down mid-morph.
			doc.dispatchEvent(new win.CustomEvent('caracms:rendered', { detail: { reason: 'morph' } }));
		} catch (error) {
			console.error('[caracms] caracms:rendered could not be sent:', error);
		}
	}

	/** Morph a render into every loaded frame; returns the frames it morphed. */
	function morphAll(html: string, reapplyLocal: boolean): FrameState[] {
		const morphed: FrameState[] = [];
		for (const state of frames.values()) {
			const doc = state.frame.document;
			if (!doc?.body || !state.good) continue;
			morphed.push(state);
			const saved = saveSelection(doc);
			// Parsed per iframe: the morph moves the new nodes into that iframe's tree.
			const next = new DOMParser().parseFromString(html, 'text/html');
			const mounted = mountedIn(doc);
			// The field's element in the render: the only node the editor may be paired with.
			const expected = mounted ? (fieldElements(next, ctxsOf(mounted.key), mounted.field, 'richText')[0] ?? null) : null;
			const editorEl = mounted?.el ?? null;
			// The body's children only (`innerHTML`): with `outerHTML`, a body that is its
			// document's activeElement would be skipped whole by ignoreActive (M1 → E2).
			Idiomorph.morph(doc.body, [...next.body.childNodes], {
				morphStyle: 'innerHTML',
				ignoreActive: !editorEl || doc.activeElement !== editorEl,
				callbacks: {
					beforeNodeMorphed(oldNode: Node, newNode: Node) {
						if (!editorEl || oldNode !== editorEl || mountedIn(doc)?.el !== editorEl) return true;
						if (expected && newNode === expected) {
							// Left alone, but the render's own attributes are what teardown restores.
							mounted!.syncAttributes(newNode as Element);
							return false;
						}
						mounted!.teardownForMorph();
						return true;
					},
				},
			});
			if (reapplyLocal) reapplyText(doc);
			restoreSelection(doc, saved);
		}
		return morphed;
	}

	/** Where the open document's block (or `PAGE_SCOPE`) is drawn on the page shown (places.ts). */
	const ctxsOf = (key: string): Ctx[] => ownCtxs(store.get(), status.get().showing, key);

	/** The fields of a block of the open document, or its page fields (`PAGE_SCOPE`). */
	function fieldsOfKey(key: string): Fields | null {
		const session = store.get();
		if (key === PAGE_SCOPE) {
			const collection = site.collections.find((c) => c.name === session.ref.collection);
			return collection?.kind === 'sections' ? (collection.fields ?? null) : null;
		}
		const block = store.block(key);
		return block?.known ? fieldsOfBlock(site, session.document, session.ref.collection, block) : null;
	}

	/** A value of the open document: a block's field, or a page field. */
	const valueAt = (key: string, field: string): unknown =>
		key === PAGE_SCOPE ? getAtPath(store.get().document.data, field) : getAtPath(store.block(key)?.data, field);

	/** Put the document's current plain text and rich text into a frame (after a render that predates it). */
	function reapplyText(doc: Document) {
		const session = store.get();
		const keys = session.document.blocks.filter((b) => b.known).map((b) => b.key);
		if (session.document.kind === 'sections' && session.document.data) keys.push(PAGE_SCOPE);
		for (const key of keys) {
			const fields = fieldsOfKey(key);
			if (!fields) continue;
			const at = ctxsOf(key);
			if (!at.length) continue;
			// A group's fields are typed on the page at their dotted paths (`left.heading`).
			const walk = (fs: Fields, prefix: string) => {
				for (const [name, field] of Object.entries(fs)) {
					const path = `${prefix}${name}`;
					if (field.kind === 'text') setText(doc, at, path, String(valueAt(key, path) ?? ''));
					else if (field.kind === 'richText') setRichText(doc, at, path, valueAt(key, path), field);
					else if (field.kind === 'group') walk(field.fields, `${path}.`);
				}
			};
			walk(fields, '');
		}
	}

	/** Put a top-level rich-text field's value into a frame, as the render's HTML; never the mounted page editor. */
	function setRichText(doc: Document, at: readonly Ctx[], field: string, value: unknown, descriptor: RichTextField) {
		for (const el of fieldElements(doc, at, field, 'richText')) {
			if (mountedIn(doc)?.el === el) continue;
			writeRichText(el, value, richTextOptions(descriptor));
		}
	}

	/** The field's descriptor in a block (or the page fields), when it's a rich-text field typed on the page (top level, or in a group). */
	function richTextDescriptor(key: string, field: string): RichTextField | null {
		const fields = fieldsOfKey(key);
		if (!fields || !isKeyPath(field)) return null;
		const descriptor = fieldAt(fields, field);
		return descriptor?.kind === 'richText' ? descriptor : null;
	}

	/**
	 * Put a plain text field's text into a frame. `\n` becomes <br> (innerText's setter;
	 * the line-break rule), or a line each in the lines rendering (field-text.ts); the text is compared as typed (field-text.ts), not as the
	 * site's CSS shows it. `skipActive`: leave the field being typed in alone (it's the
	 * source of the text, and rewriting it would lose the caret). Only fields of kind `text`:
	 * a field marked without its value (no kind) is the site's own markup, never written.
	 */
	function setText(doc: Document, at: readonly Ctx[], field: string, text: string, skipActive = false) {
		for (const el of fieldElements(doc, at, field, 'text')) {
			if (skipActive && doc.activeElement === el) continue;
			if (fieldText(el) !== shownText(el, text)) writeFieldText(el, text);
		}
	}

	store.subscribe((session, change) => {
		if (change.kind === 'load') {
			generation += 1;
			seq = createSequencer(0);
			deferred = false;
			recovering = false;
			if (pageless()) {
				// The last page stays as it is (the stage dims it); nothing renders. It's the page the
				// frames were last loaded for, even if they're still loading it (item 8).
				shownGeneration = generation;
				status.update({ opening: null, failed: false, ...(sameDoc(status.get().showing, loadedRef) ? {} : { showing: loadedRef }) });
				void maybePaint();
				return;
			}
			const showing = status.get().showing;
			// Over a page (edit in context), the frames keep that page and render it with this document on top.
			const page = target();
			status.update({ opening: sameDoc(showing, page) ? null : page, failed: false });
			if (!sameDoc(loadedRef, page)) {
				// Item 8: another page: load the frames afresh rather than morph it into this one's.
				loadedRef = page;
				freshLoad = change.adopted ? null : generation;
				if (change.adopted) deferred = true;
				for (const state of frames.values()) navigate(state, page);
				return;
			}
			request('render');
			return;
		}
		if (change.kind === 'field' && change.origin === 'page') {
			const at = ctxsOf(change.key);
			const value = valueAt(change.key, change.field);
			if (at.length && typeof value === 'string') {
				for (const f of list()) if (f.document) setText(f.document, at, change.field, value, true);
			}
			const rich = at.length ? richTextDescriptor(change.key, change.field) : null;
			if (rich) for (const f of list()) if (f.document) setRichText(f.document, at, change.field, value, rich);
			request('local');
			return;
		}
		request('render');
	});

	const driver: PreviewDriver = {
		status,
		attach(iframes) {
			const detachers: (() => void)[] = [];
			for (const width of WIDTHS) {
				const iframe = iframes[width];
				const frame: PreviewFrame = {
					width,
					trueWidth: TRUE_WIDTH[width],
					iframe,
					get document() {
						const d = iframe.contentDocument;
						return d && d.location.href !== 'about:blank' ? d : null;
					},
					get window() {
						return iframe.contentWindow;
					},
				};
				const state: FrameState = { frame, loaded: false, good: false, cleanups: new Map(), detach: null };
				frames.set(width, state);
				const onLoad = () => onFrameLoaded(state);
				iframe.addEventListener('load', onLoad);
				detachers.push(() => iframe.removeEventListener('load', onLoad));
				// Item 8: a frame made for another page than the one the frames should hold (a switch before the stage mounted).
				if (iframe.getAttribute('src') !== previewSrc(loadedRef)) iframe.src = previewSrc(loadedRef);
				// Server-rendered iframes may have loaded before the editor hydrated.
				else if (iframe.contentDocument?.readyState === 'complete') onFrameLoaded(state);
			}
			return () => {
				for (const d of detachers) d();
				for (const state of frames.values()) {
					state.detach?.();
					for (const cleanup of state.cleanups.values()) cleanup();
				}
				frames.clear();
			};
		},
		frames: list,
		frame(width) {
			const f = frames.get(width)?.frame;
			if (!f) throw new Error(`the ${width} preview isn't attached yet`);
			return f;
		},
		onLoad(listener) {
			loadListeners.add(listener);
			return () => loadListeners.delete(listener);
		},
		onMorph(listener) {
			morphListeners.add(listener);
			return () => morphListeners.delete(listener);
		},
		onFail(listener) {
			failListeners.add(listener);
			return () => failListeners.delete(listener);
		},
		registerFrameHook(hook) {
			hooks.add(hook);
			for (const state of frames.values()) if (state.loaded) runHooks(state, 'load', hook);
			return () => {
				hooks.delete(hook);
				for (const state of frames.values()) {
					state.cleanups.get(hook)?.();
					state.cleanups.delete(hook);
				}
			};
		},
		mirrorText(block, field, text, except) {
			const at: readonly Ctx[] = typeof block === 'number' ? [{ kind: 'block', index: block }] : block;
			for (const f of list()) if (f.document && f.document !== except) setText(f.document, at, field, text);
		},
		retry() {
			request('render');
		},
		srcFor: previewSrc,
	};
	return driver;
}
