/**
 * Edit in context: what an element on the page belongs to, in the editor's terms, and the
 * reverse (where the open document's fields are drawn). Every mapping between the page and
 * the editor goes through these (page-edit.ts, follow-links.ts, the driver's mirror,
 * selection.ts through markers.ts, the overlays), so one rule decides it everywhere.
 *
 * The preview shows a page (`previewStatus.showing`). Either it's the open document ("own":
 * the page is edited, as always), or a document is open over it (Decision 8: the store holds
 * the opened document, the page is shown, not edited). On the page:
 *
 * - **A block's root or a page region** is the page's: the open document's own block (by
 *   index) or page field (`PAGE_SCOPE`), or, with a document over it, the page under it.
 * - **A source** (`data-cms-source`) is that document's: the open document's own fields when
 *   it's the one open (Site Settings over a page, a footer's own slot preview), another
 *   document otherwise (a click opens it over the page).
 *
 * A form (a fields document, a shared block, Site Settings) holds its fields as one block
 * (`formKey`); a section builder drawn as a source (an entry `cms.of()` marked) has its page
 * fields there, so its key is `PAGE_SCOPE`.
 */
import { SETTINGS_PATH } from '../../../reserved.ts';
import { docId, sameDoc, type DocRef } from '../../types.ts';
import { formKey, PAGE_SCOPE, type DocumentSession } from '../state/document-store.ts';
import { blockRootOf, contextRootOf, ctxOf, ownFieldOf, type Ctx } from './markers.ts';

/** A document's source id on the page (`data-cms-source`): `settings`, or `<collection>/<path>`. */
export const sourceIdOf = (ref: DocRef): string => (ref.collection === 'settings' ? 'settings' : docId(ref));

/** The document a source id names. */
export function refOfSource(id: string): DocRef {
	if (id === 'settings') return { collection: 'settings', path: SETTINGS_PATH };
	const slash = id.indexOf('/');
	return slash < 0 ? { collection: id, path: '' } : { collection: id.slice(0, slash), path: id.slice(slash + 1) };
}

/** The view's field for a page field (`page.<path>`, as fields/PageFields.tsx picks it). */
export const pageFieldPath = (field: string): string => `${PAGE_SCOPE}.${field}`;

export type Claim =
	/** The open document's: its block's key (or `PAGE_SCOPE`), and the field when the element is in one. */
	| { kind: 'own'; key: string; ctx: Ctx; root: HTMLElement; field: string | null; fieldEl: HTMLElement | null; fieldKind: string | null }
	/** The page under an opened document: one of its blocks (by index), or its own fields (`index` null). */
	| { kind: 'page'; ctx: Ctx; root: HTMLElement; index: number | null; field: string | null; fieldEl: HTMLElement | null }
	/** Another document, drawn here as a source. `inBlock`: the page's block it sits in (a card), else null (the frame). */
	| { kind: 'source'; ref: DocRef; ctx: Ctx; root: HTMLElement; field: string | null; fieldEl: HTMLElement | null; fieldKind: string | null; inBlock: HTMLElement | null };

type Session = Pick<DocumentSession, 'ref' | 'document'>;

/** The open document's key for its fields drawn as a source: a form's one block, or a section builder's page fields. */
function sourceKey(session: Session): string | null {
	return session.document.kind === 'sections' ? PAGE_SCOPE : formKey(session);
}

/** What an element on the page shown belongs to, or null (the frame a site draws itself, nothing marked). */
export function claimOf(session: Session, showing: DocRef, el: Element): Claim | null {
	const root = contextRootOf(el);
	const ctx = root ? ctxOf(root) : null;
	if (!root || !ctx) return null;
	const fieldEl = ownFieldOf(el);
	const field = fieldEl?.dataset.cmsField ?? null;
	const fieldKind = fieldEl?.dataset.cmsKind ?? null;
	if (ctx.kind === 'source') {
		const ref = refOfSource(ctx.id);
		if (sameDoc(ref, session.ref)) {
			const key = sourceKey(session);
			return key ? { kind: 'own', key, ctx, root, field, fieldEl, fieldKind } : null;
		}
		return { kind: 'source', ref, ctx, root, field, fieldEl, fieldKind, inBlock: blockRootOf(root) };
	}
	if (!sameDoc(showing, session.ref)) {
		return { kind: 'page', ctx, root, index: ctx.kind === 'block' ? ctx.index : null, field, fieldEl };
	}
	if (ctx.kind === 'page') {
		// Only a section builder's page component marks its page fields (Contracts).
		return session.document.kind === 'sections' ? { kind: 'own', key: PAGE_SCOPE, ctx, root, field, fieldEl, fieldKind } : null;
	}
	const key = session.document.blocks[ctx.index]?.key;
	return key ? { kind: 'own', key, ctx, root, field, fieldEl, fieldKind } : null;
}

/**
 * Where the open document's block (by key; `PAGE_SCOPE` for page fields) is drawn on the page
 * shown: its block by index on its own page, the page's regions for its page fields, and its
 * source marker when it's shown over another page (or a footer's own preview, in its slot).
 */
export function ownCtxs(session: Session, showing: DocRef, key: string): Ctx[] {
	const own = sameDoc(showing, session.ref);
	const source: Ctx = { kind: 'source', id: sourceIdOf(session.ref) };
	if (key === PAGE_SCOPE) return own ? [{ kind: 'page' }] : session.document.kind === 'sections' ? [source] : [];
	const index = session.document.blocks.findIndex((b) => b.key === key);
	if (index < 0) return [];
	if (!own) return session.document.kind === 'sections' ? [] : [source];
	// A shared block's own preview: a body block is block 0, a slot block is drawn in its slot as its source.
	if (session.document.kind === 'shared') return [{ kind: 'block', index }, source];
	return [{ kind: 'block', index }];
}
