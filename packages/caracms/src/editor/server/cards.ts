/**
 * M6c (G5, Decision 19): the documents listing's card pictures, signed on the way to
 * the browser, as the library's listing carries its thumbnails (media/library.ts).
 *
 * Each listed document whose collection has the List / Grid switch and whose first
 * image was found (content.ts → `cover`) gets `card`: imgproxy `rs:fill` at the
 * collection's ratio with the focal point as gravity (media.ts → imageUrl), at
 * CARD_WIDTH and its 2× rung of the ladder, and the alt text; a clip gets its Mux poster
 * cropped the same. `cover` itself doesn't leave the server. So the grid draws at once,
 * without opening each document and without the thumbnail route's uncached redirects.
 *
 * Without the image variables (no signing), a picture has no URL: the card is a text card.
 */
import { IMAGE_WIDTHS, imageUrl, type MediaSettings } from '../../media.ts';
import { MUX_IMAGE_URL } from '../../media-value.ts';
import { ratioValue, type CardCover, type CardRatio } from '../../cards.ts';
import type { ResolvedSite } from '../../config.ts';
import type { CardPicture, ListedDocument } from '../types.ts';
import { readImagesConfig } from './media/config.ts';

/** A card's picture width, a rung of the ladder; its 2× is the next rung up that doubles it. A card is 208px at its narrowest, rarely past 320. */
export const CARD_WIDTH = 320;
export const CARD_WIDTH_2X = 640;
if (!IMAGE_WIDTHS.includes(CARD_WIDTH) || !IMAGE_WIDTHS.includes(CARD_WIDTH_2X)) throw new Error('The card widths must be rungs of IMAGE_WIDTHS.');

/** The picture's height at a width and ratio, rounded. */
export const cardHeight = (width: number, ratio: CardRatio) => Math.round(width / ratioValue(ratio));

/** A clip's Mux poster, cropped to the card (Mux's own `fit_mode=crop`), at `time` seconds (0 when unset). WebP, never the default PNG. */
export function cardPosterUrl(playbackId: string, time: number | null, width: number, ratio: CardRatio): string {
	const t = typeof time === 'number' && Number.isFinite(time) && time >= 0 ? time : 0;
	return `${MUX_IMAGE_URL}/${encodeURIComponent(playbackId)}/thumbnail.webp?width=${width}&height=${cardHeight(width, ratio)}&fit_mode=crop&time=${t}`;
}

/** One cover, signed. */
export function cardPicture(signing: MediaSettings | null, cover: CardCover, ratio: CardRatio): CardPicture | null {
	if (cover.kind === 'clip') {
		return { kind: 'clip', src: cardPosterUrl(cover.playbackId, cover.time, CARD_WIDTH, ratio), src2x: cardPosterUrl(cover.playbackId, cover.time, CARD_WIDTH_2X, ratio), alt: cover.name, duration: cover.duration };
	}
	if (!signing) return null;
	const at = (width: number) => imageUrl(signing, cover.key, { width, height: cardHeight(width, ratio), resize: 'fill', focal: cover.focal });
	const position = cover.focal ? `${Math.round(cover.focal[0] * 100)}% ${Math.round(cover.focal[1] * 100)}%` : null;
	return { kind: 'image', src: at(CARD_WIDTH), src2x: at(CARD_WIDTH_2X), alt: cover.alt, position };
}

/** The image side's signing settings, or null when the image variables aren't set. */
export function cardSigning(): MediaSettings | null {
	const config = readImagesConfig();
	return config.kind === 'unset' ? null : config.signing;
}

/** The listing as the browser gets it: each `cover` swapped for its signed `card`. */
export function withCards(site: Pick<ResolvedSite, 'collections'>, documents: readonly ListedDocument[], signing: MediaSettings | null = cardSigning()): ListedDocument[] {
	return documents.map((doc) => {
		if (!doc.cover) return doc;
		const { cover, ...rest } = doc;
		const view = site.collections[doc.collection]?.view;
		const card = view ? cardPicture(signing, cover, view.ratio) : null;
		return card ? { ...rest, card } : rest;
	});
}
