/**
 * `caracms audit`'s one hook into the render (review gaps, Decision 16): a preview is always a
 * listing's page 1 (RenderDocument and Blocks clamp `listPage`), since the editor shows a listing's
 * first page only. The audit asks for a later page (`/journal/page/2`) by marking the request's
 * locals, so the older posts' cards, and the marks they carry, are seen. Nothing else sets it: the
 * editor's preview still clamps to page 1.
 */
const PAGED = '__caracms_paged_preview';

/** Let this request's preview render follow the `listPage` it's given (the audit only). */
export function allowPagedPreview(locals: object): void {
	(locals as Record<string, unknown>)[PAGED] = true;
}

/** Does this request's preview follow `listPage`? False for every render but the audit's. */
export function pagedPreview(locals: object | undefined): boolean {
	return (locals as Record<string, unknown> | undefined)?.[PAGED] === true;
}
