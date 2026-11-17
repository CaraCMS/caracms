/**
 * Replace… on a file in the library (M6c G4, Decision 9;
 * M6c): every link to the old file, in every document
 * the store lists (Site Settings and shared blocks included), points at the new one,
 * `?download` and a fragment kept. The rules both stores apply, and what changes.
 *
 * - **Links are found by schema** (relink.ts → `refileText`, the walk a page move uses):
 *   a link field's or a button's `href`, and rich text's links. A plain-text mention of
 *   the address is never changed.
 * - **Both keys are a file's** (caracms/files → `isFileKey`), and not the same key: the
 *   same bytes are the same key (content-addressed), so there's nothing to replace. The
 *   new file must be in the bucket already (uploaded first, through the upload route):
 *   the media route checks that before the store is asked (media/handler.ts).
 * - **Nothing is deleted**: the old file stays in the bucket at its address.
 * - **An image's Replace…** (both keys an image's, `reimageText`): every value with the old
 *   key as its `key` (any object, in any block, a kept unknown one and the brand's logo
 *   included, as where-used finds them: library.ts → `mediaUses`) takes the new key and the
 *   new image's `w` and `h`. Its alt text and decorative flag stay (the same picture's
 *   meaning, usually); its focal point stays unless `resetFocal` asks (a different shot).
 *   Any other member stays as it was, in its place. An image is never replaced by a file,
 *   nor a file by an image.
 *
 * The stores apply the changes as a move's relinked files are applied: local mode writes
 * each file (atomic, confined; no rollback, as a local move has none), live mode stores
 * each as an autosave under this tab's locks and lands whole or rolls back
 * (live/drafts-store.ts → `replaceFile`).
 */
import type { ResolvedSite } from '../../config.ts';
import type { DocumentEntry } from '../../content.ts';
import { isFileKey } from '../../files.ts';
import { member, parseSource, slice, type JsonNode, type ObjectNode } from '../../json-source.ts';
import { refileText } from '../../relink.ts';
import type { ReplaceFileRequest, ReplaceFileResponse } from '../types.ts';
import { refused } from './create.ts';

type Site = Pick<ResolvedSite, 'collections' | 'blocks'>;

const SHAPE = '{ from, to } (an image\'s may add resetFocal)';

/** An image upload's key (`uploads/<12 hex>/<name>`, not a file's): what a media slot stores. */
export const isImageKey = (key: unknown): key is string => typeof key === 'string' && /^uploads\/[0-9a-f]{12}\/[^/\u0000-\u001f\u007f]{1,255}$/.test(key) && !isFileKey(key);

/** Validate a replace body's shape and keys. Throws WriteRefused 400. */
export function parseReplaceBody(body: unknown): ReplaceFileRequest {
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw refused(400, 'bad-request', `Malformed body: it must be a JSON object. Send ${SHAPE}.`);
	const b = body as Record<string, unknown>;
	const extra = Object.keys(b).filter((k) => k !== 'from' && k !== 'to' && k !== 'resetFocal');
	if (extra.length) throw refused(400, 'bad-request', `Malformed body: unexpected keys. Send ${SHAPE}.`);
	if (isImageKey(b.from)) {
		if (!isImageKey(b.to)) throw refused(400, 'bad-request', '"to" must be an image\'s key in the library (uploads/<hash>/<name>.<ext>): an image is replaced by an image.');
		if (b.resetFocal !== undefined && typeof b.resetFocal !== 'boolean') throw refused(400, 'bad-request', '"resetFocal" must be true or false.');
		if (b.from === b.to) throw refused(400, 'same', "That's the same image.");
		return { from: b.from, to: b.to, ...(b.resetFocal ? { resetFocal: true } : {}) };
	}
	if (!isFileKey(b.from)) throw refused(400, 'bad-request', '"from" must be a file\'s or an image\'s key in the library (uploads/<hash>/<name>.<ext>).');
	if (!isFileKey(b.to)) throw refused(400, 'bad-request', '"to" must be a file\'s key in the library (uploads/<hash>/<name>.<ext>).');
	if (b.resetFocal !== undefined) throw refused(400, 'bad-request', `Malformed body: a file has no focal point. Send ${SHAPE}.`);
	if (b.from === b.to) throw refused(400, 'same', "That's the same file.");
	return { from: b.from, to: b.to };
}

/**
 * An image's Replace…: the text with every value whose `key` is `from` (trimmed, as
 * where-used reads it) holding `to` and the new size, spliced in; `links` counts the values.
 * Each value is written on one line (mediaLine's form, as the files hold them), its own
 * members in their order: `key` swapped, `w` and `h` set (added after the rest when it had
 * none; dropped when the new image's are unknown), `focal` dropped when `resetFocal`.
 */
export function reimageText(text: string, request: Pick<ReplaceFileRequest, 'from' | 'to' | 'resetFocal' | 'size'>): { text: string; links: number } {
	let source;
	try {
		source = parseSource(text);
	} catch {
		return { text, links: 0 };
	}
	const edits: { start: number; end: number; text: string }[] = [];
	const visit = (node: JsonNode, depth: number): void => {
		if (depth > 64) return;
		if (node.kind === 'array') return node.items.forEach((item) => visit(item, depth + 1));
		if (node.kind !== 'object') return;
		const key = member(node, 'key')?.value;
		if (key && key.kind === 'scalar' && typeof key.value === 'string' && key.value.trim() === request.from) {
			edits.push({ start: node.start, end: node.end, text: rewritten(node) });
			return;
		}
		for (const m of node.members) visit(m.value, depth + 1);
	};
	const rewritten = (node: ObjectNode): string => {
		const members: [string, string][] = [];
		const seen = new Set<string>();
		for (const m of node.members) {
			if (seen.has(m.key)) continue; // a repeated key: the last one wins (JSON.parse's rule), written once
			seen.add(m.key);
			const value = member(node, m.key)!.value;
			if (m.key === 'key') members.push(['key', JSON.stringify(request.to)]);
			else if (m.key === 'focal' && request.resetFocal) continue;
			else if (m.key === 'w' || m.key === 'h') continue;
			else members.push([m.key, oneLine(slice(source, value))]);
		}
		for (const side of ['w', 'h'] as const) {
			const n = request.size?.[side];
			if (typeof n === 'number' && Number.isFinite(n) && n > 0) members.push([side, String(n)]);
		}
		return `{ ${members.map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(', ')} }`;
	};
	visit(source.root, 0);
	if (edits.length === 0) return { text, links: 0 };
	let out = text;
	for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
	return { text: out, links: edits.length };
}

/** A member's value on one line: a focal pair as `[0.4, 0.3]`, anything else compact. */
function oneLine(json: string): string {
	const value = JSON.parse(json) as unknown;
	return Array.isArray(value) ? `[${value.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(value);
}

export interface Refiled {
	file: string;
	collection: string;
	path: string;
	title: string;
	text: string;
	links: number;
}

/** Every document whose text changes, from the store's own texts (`readText` by site-relative file; live mode's has the autosaves on top). */
export async function replaceChanges(site: Site, request: ReplaceFileRequest, documents: readonly DocumentEntry[], readText: (file: string) => Promise<string | null>): Promise<Refiled[]> {
	const out: Refiled[] = [];
	for (const d of documents) {
		const collection = site.collections[d.collection];
		if (!collection) continue;
		const text = await readText(d.file);
		if (text === null) continue;
		const after = isImageKey(request.from) ? reimageText(text, request) : refileText(text, request.from, request.to, site, collection);
		if (after.links) out.push({ file: d.file, collection: d.collection, path: d.path, title: d.label, text: after.text, links: after.links });
	}
	return out;
}

export const replaceResponse = (request: ReplaceFileRequest, changes: readonly Refiled[]): ReplaceFileResponse => ({
	ok: true,
	from: request.from,
	to: request.to,
	relinked: changes.map(({ collection, path, title, links }) => ({ collection, path, title, links })),
});
