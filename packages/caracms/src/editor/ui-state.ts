/**
 * Per-browser state the sidebar shows at first paint, in a cookie the server reads
 * (Decision 20): which Pages groups are open, and the Recent strip. Kept in a cookie
 * rather than the browser's storage because the chrome is server-rendered: state the
 * server can't see would paint one way and flip after hydration (M2 Decision 9).
 *
 * The open rule (Decision 8): a group starts open if it holds the open document;
 * otherwise it's as the person last left it, and closed if they never touched it.
 * Opening a document opens its ancestors in the state (withOpenAncestors), so it
 * stays as they leave it afterwards.
 *
 * M6c (G5, Decision 18): each flat collection's List / Grid choice is kept here too, so
 * the server paints the view the editor left (`views`; absent: the config's default).
 */
import type { DocRef, UiState, ViewMode } from './types.ts';
import { docId } from './types.ts';

export const UI_COOKIE = 'caracms-ui';
const RECENT_MAX = 8;

export const emptyUiState = (): UiState => ({ open: {}, recent: [] });

/** A group's key: `<collection>:<folder path>` (`pages:services`, `pages:about`). */
/** The state with the sidebar hidden or shown (shown leaves no key). */
export function withSide(state: UiState, hidden: boolean): UiState {
	if ((state.side === 'hidden') === hidden) return state;
	if (hidden) return { ...state, side: 'hidden' };
	const { side: _, ...rest } = state;
	return rest;
}

export const groupKey = (collection: string, path: string) => `${collection}:${path}`;

/** The cookie's value (already URI-decoded or not; both are accepted). Never throws. */
export function parseUiState(raw: string | null | undefined): UiState {
	if (!raw) return emptyUiState();
	let value: unknown;
	try {
		value = JSON.parse(raw.startsWith('%') ? decodeURIComponent(raw) : raw);
	} catch {
		try {
			value = JSON.parse(decodeURIComponent(raw));
		} catch {
			return emptyUiState();
		}
	}
	const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	const open: Record<string, boolean> = {};
	if (v.open && typeof v.open === 'object') {
		for (const [key, on] of Object.entries(v.open as Record<string, unknown>)) {
			if (typeof on === 'boolean' && key.length < 200) open[key] = on;
		}
	}
	const recent = Array.isArray(v.recent) ? v.recent.filter((r): r is string => typeof r === 'string' && r.length < 300).slice(0, RECENT_MAX) : [];
	const state: UiState = v.side === 'hidden' ? { open, recent, side: 'hidden' } : { open, recent };
	// M6c (G5, Decision 18): each collection's List / Grid choice.
	if (v.views && typeof v.views === 'object') {
		const views: Record<string, ViewMode> = {};
		for (const [name, mode] of Object.entries(v.views as Record<string, unknown>)) {
			if ((mode === 'list' || mode === 'grid') && name.length < 100) views[name] = mode;
		}
		if (Object.keys(views).length) state.views = views;
	}
	return state;
}

/** M6c (G5, Decision 18): the view a collection shows: the editor's own choice, else the config's default. */
export const viewModeOf = (state: UiState, collection: string, fallback: ViewMode): ViewMode => state.views?.[collection] ?? fallback;

/** The state with a collection's List / Grid choice made. */
export function withViewMode(state: UiState, collection: string, mode: ViewMode): UiState {
	return state.views?.[collection] === mode ? state : { ...state, views: { ...state.views, [collection]: mode } };
}

export const serializeUiState = (state: UiState) => encodeURIComponent(JSON.stringify(state));

/**
 * Open every folder above a document (its groups, and pages with children above it). Page
 * folders: with the listing's `folders`, every page folder holding it or a row above it too
 * (its key `pages:(company)`, as nav/tree.ts → folderPath).
 */
export function withOpenAncestors(state: UiState, ref: DocRef, folders: Record<string, readonly { id: string; rows: readonly string[] }[]> = {}): UiState {
	const segments = ref.path.split('/');
	const open = { ...state.open };
	let changed = false;
	const opened = (key: string) => {
		if (open[key] !== true) {
			open[key] = true;
			changed = true;
		}
	};
	for (let i = 1; i < segments.length; i++) opened(groupKey(ref.collection, segments.slice(0, i).join('/')));
	for (let i = 1; i <= segments.length; i++) {
		const node = segments.slice(0, i).join('/');
		const level = segments.slice(0, i - 1).join('/');
		const folder = (folders[level] ?? []).find((f) => f.rows.includes(node));
		if (folder) opened(groupKey(ref.collection, level === '' ? `(${folder.id})` : `${level}/(${folder.id})`));
	}
	return changed ? { ...state, open } : state;
}

export function withRecent(state: UiState, ref: DocRef): UiState {
	const id = docId(ref);
	if (state.recent[0] === id) return state;
	return { ...state, recent: [id, ...state.recent.filter((r) => r !== id)].slice(0, RECENT_MAX) };
}

export function withToggled(state: UiState, key: string, open: boolean): UiState {
	return state.open[key] === open ? state : { ...state, open: { ...state.open, [key]: open } };
}

/** The cookie as the browser sets it (a year, the whole site so /admin/* all send it). */
export const uiCookieString = (state: UiState) => `${UI_COOKIE}=${serializeUiState(state)}; Path=/; Max-Age=31536000; SameSite=Lax`;

/**
 * Whether this browser holds unsent edits for a site (keeper.ts), so the server can
 * render the bar as Keeping at first paint after a reload rather than a Kept that
 * isn't true yet. One cookie per site (`storageKey`), only while something is held.
 */
export const unsentCookieName = (storageKey: string) => `caracms-unsent-${storageKey}`;
export const unsentCookieString = (storageKey: string, held: boolean) =>
	held ? `${unsentCookieName(storageKey)}=1; Path=/; Max-Age=31536000; SameSite=Lax` : `${unsentCookieName(storageKey)}=; Path=/; Max-Age=0; SameSite=Lax`;
