/**
 * What /admin server-renders from (and hydrates with): the site as the browser may
 * see it, the document list, the open document as read now, and the per-browser
 * sidebar state from the cookie (Decision 20).
 */
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import type { Brand, ResolvedSite } from '../../config.ts';
import { DocumentError } from '../../content.ts';
import { heldBases, withHeldBases } from '../../held.ts';
import { inboxFromAddress, isArrangeAddress, refFromAddress } from '../addresses.ts';
import { handleSubmissions, SUBMISSIONS_PREFIX, submissionsSetupQuick, type SubmissionResponse, type SubmissionsListResponse } from '../../forms/inbox.ts';
import { ENDPOINTS, type AdminProps, type DocRef, type EditorSite, type ListedDocument, type LiveProps, type MediaSetup, type EditorForm, type Person, type StatusResponse } from '../types.ts';
import { isOrderedCollection } from '../../page-order.ts';
import { parseUiState, UI_COOKIE, unsentCookieName, withOpenAncestors, withRecent, withSide } from '../ui-state.ts';
import type { DraftsStore } from './drafts-store.ts';
import { editorMode, liveEditorOf } from './mode.ts';
import { readImagesConfig, readMuxConfig } from './media/config.ts';
import { currentBrand, editorBrand } from './settings.ts';
import { ACCENT_PRESETS } from '../brand.ts';
import { withCards } from './cards.ts';
import { pagesLayout } from './arrange.ts';
import { zoneName } from '../zone-name.ts';

/** Home: the top `index` of the first nested collection, else the first document that opens. */
export function homeOf(site: Pick<ResolvedSite, 'collections'>, documents: readonly ListedDocument[]): DocRef {
	for (const collection of Object.values(site.collections)) {
		if (collection.nested && documents.some((d) => d.collection === collection.name && d.path === 'index' && !d.warning)) {
			return { collection: collection.name, path: 'index' };
		}
	}
	const first = documents.find((d) => !d.warning && d.kind === 'sections');
	return first ? { collection: first.collection, path: first.path } : { collection: Object.keys(site.collections)[0]!, path: 'index' };
}

/**
 * `brand`: the brand as it applies now (settings.ts → currentBrand: Site Settings as
 * committed, M5a Decision 10).
 */
export function editorSite(site: ResolvedSite, documents: readonly ListedDocument[], host: string, brand: Brand): EditorSite {
	// Every kind of collection (M5a Phase 5): the site's own in config order, then `shared` and `settings`.
	// Collections under pages (Decision 7): a held collection's urlBase is resolved from the listing, so the browser never works one out.
	const bases = heldBases(site.collections, documents);
	const collections = Object.values(withHeldBases(site, bases).collections).map(({ name, label, kind, urlBase, nested, fields, columns, sort, order, view, blocks, heldBy }) => {
		const held = heldBy ? bases[name] : undefined;
		return {
			name,
			label,
			kind,
			urlBase,
			nested,
			fields,
			columns,
			sort: sort ?? null,
			...(order ? { order } : {}),
			view: view ?? null,
			blocks: blocks ?? null,
			...(held ? { heldBy, holder: held.holder && !held.problem ? { collection: held.holder.collection, path: held.holder.path } : null, problem: held.problem } : {}),
		};
	});
	return {
		collections,
		allCollections: collections,
		blocks: Object.fromEntries(
			Object.entries(site.blocks).map(([type, block]) => [type, { ...block, component: relative(site.root, block.component).split('\\').join('/') }]),
		),
		textStyles: Object.fromEntries(
			Object.values(site.textStyles).map((style) => [style.name, { name: style.name, sizePx: style.sizePx, minSizePx: style.minSizePx }]),
		),
		brand: editorBrand(brand),
		presets: ACCENT_PRESETS,
		phoneLinesWidth: site.phoneLinesWidth,
		home: homeOf(site, documents),
		host,
		storageKey: createHash('sha256').update(site.root).digest('base64url').slice(0, 10),
		timeZone: site.timeZone,
		timeZoneName: zoneName(site.timeZone),
		codeRoutes: site.codeRoutes ?? [],
	};
}

/**
 * Editor wording note (caracms-cloud adversarial review): `/admin` on a site with no page to
 * open yet (a new site, right after `init`): the file Home would be, site-relative, for the
 * empty state (empty-site.ts) instead of a bare "no document" line.
 */
export interface EmptySite {
	file: string;
}

export type AdminPropsResult = { ok: true; props: AdminProps } | { ok: false; status: number; message: string; empty?: EmptySite };

export async function adminProps(input: {
	site: ResolvedSite;
	store: DraftsStore;
	url: URL;
	/** Read a cookie by name (Astro.cookies). */
	cookie: (name: string) => string | undefined;
	/** Live mode: the signed-in person (the guard's, locals.ts). Absent or null in local mode. */
	person?: Person | null;
}): Promise<AdminPropsResult> {
	const { site, store, url } = input;
	const documents = withCards(site, await store.list());
	const editor = editorSite(site, documents, url.host, await currentBrand(site));
	// M6 Decision 9: /admin/submissions[/<id>] opens the editor on the inbox, over Home.
	const inbox = inboxFromAddress(url.pathname);
	if (inbox === 'bad') return { ok: false, status: 404, message: `There's no submission at ${url.pathname}.` };
	// Arrange pages (Decision 15): /admin/arrange opens the arrange screen, over Home, with nothing arranged.
	const arrange = isArrangeAddress(url.pathname);
	const ref = inbox || arrange ? editor.home : refFromAddress(url.pathname, editor.collections.map((c) => c.name), editor.home);
	if (!ref) return { ok: false, status: 404, message: `There's no document at ${url.pathname}.` };
	try {
		const opened = await store.read(ref.collection, ref.path);
		const pages = await pagesLayout(site, documents, await store.source());
		// A hidden sidebar stays hidden only for a section-builder page; any other kind of
		// document is edited in the sidebar, so it paints shown (the client's bringSideBack).
		const inPages = Object.values(site.collections).some((c) => c.name === ref.collection && isOrderedCollection(c));
		const painted = withRecent(withOpenAncestors(parseUiState(input.cookie(UI_COOKIE)), ref, inPages ? pages.folders : {}), ref);
		const ui = opened.entry.kind === 'sections' ? painted : withSide(painted, false);
		const unsent = input.cookie(unsentCookieName(editor.storageKey)) === '1';
		const live = await liveProps(site, url, opened.entry.file, input.person ?? null);
		const submissions = await submissionsSetupQuick({ site });
		// The inbox's first page (and the submission the address names) in the first paint: no empty list that fills in.
		const inboxFirst = inbox && submissions.unread !== null ? await inboxFirstPaint(site, url, inbox.id, input.person ?? null) : null;
		return { ok: true, props: { site: editor, documents, pages, opened, ui, unsent, live, media: mediaSetup(), inbox, ...(arrange ? { arrange } : {}), submissions, forms: formsOf(site), inboxFirst } };
	} catch (error) {
		if (error instanceof DocumentError) {
			// No page to open at all (homeOf found none): the empty state, at the editor's own address only.
			const bare = url.pathname.replace(/\/+$/, '') === '/admin';
			const home = editor.home;
			const nothing = error.code === 'not-found' && bare && ref.collection === home.collection && ref.path === home.path && !documents.some((d) => d.kind === 'sections' && !d.warning);
			const empty = nothing ? { file: `${relative(site.root, site.collections[home.collection]!.dir).split('\\').join('/')}/${home.path}.json` } : undefined;
			return { ok: false, status: error.code === 'not-found' ? 404 : 400, message: error.message, ...(empty ? { empty } : {}) };
		}
		throw error;
	}
}

/**
 * Live mode's start for the page (M4 Phase 4): who is signed in and the status as the
 * poll would answer it, so the bar's waiting count, Publish, the avatar and a lock's
 * veil are in the first paint (no skeletons). Read with no tab, so presence isn't
 * recorded and a lock of your own reads as another tab's until the tab's first poll.
 * Null in local mode.
 */
async function liveProps(site: ResolvedSite, url: URL, file: string, person: Person | null): Promise<LiveProps | null> {
	const mode = editorMode();
	if (mode.kind !== 'live' || !person) return null;
	let status: StatusResponse | null = null;
	try {
		const live = await liveEditorOf(site);
		const response = await live!.status(new Request(`${url.origin}${ENDPOINTS.status}?file=${encodeURIComponent(file)}`), person);
		if (response.ok) status = (await response.json()) as StatusResponse;
	} catch (error) {
		console.warn(`[caracms] /admin couldn't read the status for its first paint (${error instanceof Error ? error.message : String(error)}); the first poll fills it`);
	}
	const t = mode.settings.timings;
	return { you: person, status, pollMs: t.pollMs, idleSlowAfterMs: t.idleSlowAfterMs, slowPollMs: t.slowPollMs, keepDelayMs: t.keepDelayMs, keepCapMs: t.keepCapMs };
}

/**
 * M6: what /admin/submissions[/<id>] paints first, read through the inbox's own handler
 * (so the same checks run): the first page, and the submission the address names. A read
 * that fails leaves its part null, and the browser reads it again.
 */
async function inboxFirstPaint(site: ResolvedSite, url: URL, id: string | null, person: Person | null): Promise<NonNullable<AdminProps['inboxFirst']>> {
	const ctx = { site, mode: editorMode().kind === 'live' ? ('live' as const) : ('local' as const), person: person?.email ?? null };
	const read = async <T,>(path: string): Promise<T | null> => {
		try {
			const response = await handleSubmissions(new Request(`${url.origin}${SUBMISSIONS_PREFIX}${path}`), ctx);
			return response.ok ? ((await response.json()) as T) : null;
		} catch {
			return null;
		}
	};
	const [list, open] = await Promise.all([read<SubmissionsListResponse>(''), id ? read<SubmissionResponse>(`/${encodeURIComponent(id)}`) : Promise.resolve(null)]);
	return { list, open };
}

/** M6: the site's forms as the editor needs them (Site Settings' Form emails, the Form block's picker): id, label and fields. */
export function formsOf(site: Pick<ResolvedSite, 'forms'>): EditorForm[] {
	return Object.values(site.forms).map(({ id, label, fields }) => ({ id, label, fields }));
}

/**
 * M5b Decision 5: whether the media routes are set up, for the media field's first paint
 * (the 503's sentence in place of its controls). Only the sentence and the missing names
 * reach the browser, never a value.
 */
export function mediaSetup(): MediaSetup {
	const images = readImagesConfig();
	const clips = readMuxConfig();
	return {
		images: images.kind === 'unset' ? { error: images.message, code: 'media-unset', missing: images.missing } : null,
		clips: clips.kind === 'unset' ? { error: clips.message, code: 'mux-unset', missing: clips.missing } : null,
	};
}
