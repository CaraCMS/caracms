/**
 * M6c (G5): the grid view of a flat collection, package side. Pure, so the config's
 * check (config.ts), the listing (content.ts) and the editor share one reading.
 *
 * - **Which collections get the switch** (Decision 13): a flat collection whose
 *   documents can hold an image. A fields collection with a media field anywhere in its
 *   fields (lists included); a section builder when any of the site's blocks, or its own
 *   page fields, has one. Never Pages (nested), Shared blocks or Site Settings.
 * - **A card's picture** (Decision 14): the document's first image. A fields document:
 *   the first in schema order, or the field `view.image` names (a list of media gives its
 *   first item). A section builder's: its page fields first, then each block in order,
 *   shared entries and unknown blocks skipped. A clip (a loop too) stands as its poster.
 * - **The config** (Decision 17): `view: { default?, image?, ratio? }`; defaults list, the
 *   first image, 4:3.
 */
import { firstMedia, holdsMedia, type Fields } from './fields.ts';
import { parseMedia, renderMedia, type RenderMedia } from './media-value.ts';
import type { DocumentBlock } from './document.ts';

export const VIEW_MODES = ['list', 'grid'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

/** A card's picture ratios, as the config writes them. */
export const CARD_RATIOS = ['4:3', '3:2', '1:1', '16:9', '3:4'] as const;
export type CardRatio = (typeof CARD_RATIOS)[number];

/** `view` in a collection's config (Decision 17). */
export interface ViewConfig {
	/** The view a collection opens in until an editor picks one (then the editor's own choice, Decision 18). Default `'list'`. */
	default?: ViewMode;
	/** A fields collection only: the top-level media field (or list of media) a card shows. Default: the first image. */
	image?: string;
	/** The card's picture ratio. Default `'4:3'`. */
	ratio?: CardRatio;
}

/** A collection's view, checked and defaulted; on a collection only when it gets the switch. */
export interface ResolvedView {
	default: ViewMode;
	image: string | null;
	ratio: CardRatio;
}

export const defaultResolvedView = (): ResolvedView => ({ default: 'list', image: null, ratio: '4:3' });

/** `'4:3'` → 4 / 3. */
export function ratioValue(ratio: CardRatio): number {
	const [w, h] = ratio.split(':').map(Number);
	return w! / h!;
}

/** Can a flat collection's documents hold an image (Decision 13)? `blocks`: every block's fields (a section builder can take any of them). */
export function collectionHoldsImages(collection: { kind: string; nested: boolean; fields: Fields | null }, blocks: Iterable<{ fields: Fields }>): boolean {
	if (collection.nested) return false;
	if (collection.kind === 'fields') return holdsMedia(collection.fields);
	if (collection.kind !== 'sections') return false;
	if (holdsMedia(collection.fields)) return true;
	for (const b of blocks) if (holdsMedia(b.fields)) return true;
	return false;
}

/** A card's picture before it's signed: an image's key, alt and focal point, or a clip's poster. */
export type CardCover =
	| { kind: 'image'; key: string; alt: string; focal: [number, number] | null }
	| { kind: 'clip'; playbackId: string; time: number | null; duration: number | null; name: string };

function coverOf(value: unknown, media: RenderMedia): CardCover {
	if (media.kind === 'image') return { kind: 'image', key: media.key, alt: media.alt, focal: media.focal };
	const stored = parseMedia(value);
	const time = stored && 'video' in stored && typeof stored.poster === 'number' ? stored.poster : null;
	return { kind: 'clip', playbackId: media.playbackId, time, duration: media.duration, name: media.name };
}

/** A fields document's cover: `view.image`'s field when named, else the first image in schema order. */
export function fieldsCover(fields: Fields, data: Record<string, unknown>, image: string | null): CardCover | null {
	if (image !== null) {
		const field = fields[image];
		if (field?.kind === 'media') {
			const media = renderMedia(data[image], { only: field.only, play: field.play });
			return media ? coverOf(data[image], media) : null;
		}
		if (field?.kind === 'list' && field.item?.kind === 'media' && Array.isArray(data[image])) {
			const item = field.item;
			for (const v of data[image] as unknown[]) {
				const media = renderMedia(v, { only: item.only, play: item.play });
				if (media) return coverOf(v, media);
			}
		}
		return null;
	}
	const found = firstMedia(fields, data);
	return found ? coverOf(found.value, found.media) : null;
}

/** A section builder's document's cover: its page fields' first image, then each block's in order (shared entries and unknown blocks skipped). */
export function sectionsCover(pageFields: Fields | null, data: Record<string, unknown> | undefined, blocks: readonly DocumentBlock[], schemas: Record<string, { fields: Fields }>): CardCover | null {
	if (pageFields && data) {
		const found = firstMedia(pageFields, data);
		if (found) return coverOf(found.value, found.media);
	}
	for (const block of blocks) {
		if (block.shared !== undefined || !block.known) continue;
		const schema = schemas[block.type];
		if (!schema) continue;
		const found = firstMedia(schema.fields, block.data);
		if (found) return coverOf(found.value, found.media);
	}
	return null;
}

/**
 * `view` from a collection's config, checked (Decision 17): null when the collection
 * gets no switch (and then `view` is refused if set, with a sentence); else the
 * defaulted view. `fields` is the collection's (a fields collection's, or a section
 * builder's page fields).
 */
export function checkView(
	where: string,
	raw: unknown,
	collection: { kind: 'fields' | 'sections'; nested: boolean; fields: Fields | null },
	blocks: Iterable<{ fields: Fields }>,
	fail: (message: string) => never,
): ResolvedView | null {
	const switches = collectionHoldsImages(collection, blocks);
	if (raw === undefined) return switches ? defaultResolvedView() : null;
	if (collection.nested) fail(`${where}: view is for a flat collection's List / Grid switch; a nested one (Pages) is a tree.`);
	if (!switches) {
		fail(
			collection.kind === 'fields'
				? `${where}: view: its documents have no media field, so there's nothing to show as a grid. Add a media() field, or take view out.`
				: `${where}: view: none of the blocks it offers has a media field, so there's nothing to show as a grid. Take view out.`,
		);
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${where}: view must be an object, like { default: 'grid', ratio: '3:2' }.`);
	const v = raw as Record<string, unknown>;
	for (const key of Object.keys(v)) {
		if (key !== 'default' && key !== 'image' && key !== 'ratio') fail(`${where}: view has no "${key}"; it takes default, image and ratio.`);
	}
	const view = defaultResolvedView();
	if (v.default !== undefined) {
		if (!(VIEW_MODES as readonly unknown[]).includes(v.default)) fail(`${where}: view.default must be 'list' or 'grid' (got ${JSON.stringify(v.default)}).`);
		view.default = v.default as ViewMode;
	}
	if (v.ratio !== undefined) {
		if (!(CARD_RATIOS as readonly unknown[]).includes(v.ratio)) fail(`${where}: view.ratio must be one of ${CARD_RATIOS.map((r) => `'${r}'`).join(', ')} (got ${JSON.stringify(v.ratio)}).`);
		view.ratio = v.ratio as CardRatio;
	}
	if (v.image !== undefined) {
		if (collection.kind !== 'fields') fail(`${where}: view.image is for a list-of-fields collection; a section builder's card shows the first image in its page fields or blocks.`);
		if (typeof v.image !== 'string' || v.image === '') fail(`${where}: view.image must name one of its media fields (got ${JSON.stringify(v.image)}).`);
		const field = collection.fields?.[v.image];
		if (!field) fail(`${where}: view.image: "${v.image}" isn't one of its fields; name a media field, or a list of media.`);
		const isMedia = field.kind === 'media' || (field.kind === 'list' && field.item?.kind === 'media');
		if (!isMedia) fail(`${where}: view.image: "${v.image}" is a ${field.kind === 'list' ? 'list of fields' : `${field.kind} field`}; a card's picture comes from a media field, or a list of media (its first item).`);
		view.image = v.image;
	}
	return view;
}
