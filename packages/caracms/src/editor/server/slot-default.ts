/**
 * Edit in context, Decision 3: "Default <slot>" on a slot block's form. One shared block per
 * slot is the site's default; turning the switch on for one turns it off on the others. The
 * rules both stores apply, and what changes.
 *
 * - **The block asked for** must be a shared block whose type the code knows and fills a slot.
 *   Its own `"default": true` is the editor's edit (the open document's, written by the keeper
 *   as any field is), so a later write of its form never puts the file's old value back.
 * - **The others** of that slot that say `"default": true` are each written without it, as a
 *   normal save would write them (serialize.ts: `default: false` takes the key out). One that
 *   isn't a default isn't written at all.
 *
 * Local mode writes each file (atomic, confined, as a Replace… does); live mode takes every
 * file's lock first, so someone else editing one refuses it all, naming them, then stores each
 * as an autosave and lands whole or rolls back (live/drafts-store.ts → `slotDefault`).
 */
import type { ResolvedSite } from '../../config.ts';
import type { DocumentEntry } from '../../content.ts';
import { own, parseAnyDocument, type SharedDocument } from '../../document.ts';
import { applyDocumentEdits } from '../../serialize.ts';
import type { SlotDefaultRequest, SlotDefaultResponse } from '../types.ts';
import { refused } from './create.ts';

type Site = Pick<ResolvedSite, 'collections' | 'blocks'>;

const SHAPE = '{ path }';

/** Validate a body's shape and keys. Throws WriteRefused 400. */
export function parseSlotDefaultBody(body: unknown): SlotDefaultRequest {
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw refused(400, 'bad-request', `Malformed body: it must be a JSON object. Send ${SHAPE}.`);
	const b = body as Record<string, unknown>;
	if (Object.keys(b).some((k) => k !== 'path')) throw refused(400, 'bad-request', `Malformed body: unexpected keys. Send ${SHAPE}.`);
	if (typeof b.path !== 'string' || b.path === '') throw refused(400, 'bad-request', `Malformed body: "path" must be a shared block's path. Send ${SHAPE}.`);
	return { path: b.path };
}

export interface Undefaulted {
	file: string;
	collection: string;
	path: string;
	title: string;
	text: string;
}

/** The other defaults of the asked-for block's slot, each without its `default` (`readText` by site-relative file; live mode's has the autosaves on top). Throws WriteRefused. */
export async function slotDefaultChanges(site: Site, request: SlotDefaultRequest, documents: readonly DocumentEntry[], readText: (file: string) => Promise<string | null>): Promise<Undefaulted[]> {
	const entry = documents.find((d) => d.collection === 'shared' && d.path === request.path);
	if (!entry) throw refused(404, 'not-found', `Shared blocks: no shared block "${request.path}".`);
	if (!entry.slot) throw refused(400, 'not-allowed', `${entry.label} isn't a header or footer, so it can't be a default.`);
	const collection = own(site.collections, 'shared')!;
	const out: Undefaulted[] = [];
	for (const d of documents) {
		if (d.collection !== 'shared' || d.path === entry.path || d.slot !== entry.slot || !d.default) continue;
		const text = await readText(d.file);
		if (text === null) continue;
		const document = parseAnyDocument(JSON.parse(text), site, collection) as SharedDocument;
		const after = applyDocumentEdits(text, { ...document, default: false }, site, collection);
		if (after !== text) out.push({ file: d.file, collection: d.collection, path: d.path, title: d.label, text: after });
	}
	return out;
}

export const slotDefaultResponse = (request: SlotDefaultRequest, changes: readonly Undefaulted[]): SlotDefaultResponse => ({
	ok: true,
	path: request.path,
	undefaulted: changes.map(({ path, title }) => ({ path, title })),
});
