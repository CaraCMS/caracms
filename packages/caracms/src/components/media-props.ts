/**
 * `<Media>`'s props (Media.astro), in a module of their own so a test can type-check them
 * (test/media-props.test.ts).
 */
import type { HTMLAttributes } from 'astro/types';
import type { BlockContext } from '../document.ts';

/**
 * M8 trial (item 13): the element's own attributes (`draggable`, `id`, `title`, `data-*`…)
 * type-check and pass through, on the `<img>`, the loop's `<video>` or the player. What the
 * component sets itself (the sources, `alt`, the size) isn't the caller's.
 */
type Passed = Omit<HTMLAttributes<'img'>, 'src' | 'srcset' | 'alt' | 'sizes' | 'width' | 'height' | 'loading' | 'fetchpriority' | 'decoding' | 'class' | 'style'>;

export interface MediaProps extends Passed {
	cms: BlockContext;
	/** The slot's dotted path in the block's (or fields document's) schema: its markers and its `only`/`play`. */
	field?: string;
	value: unknown;
	/** Fluid: the rendered width at each breakpoint, from the block's CSS. */
	sizes?: string;
	/** Fluid: crop to this shape (width / height). */
	ratio?: number;
	minWidth?: number;
	maxWidth?: number;
	/** Fixed: the CSS size in px. */
	width?: number;
	height?: number;
	fit?: 'cover' | 'contain';
	loading?: 'eager' | 'lazy';
	fetchpriority?: 'high' | 'low' | 'auto';
	class?: string;
	style?: string;
	[attribute: `data-${string}`]: unknown;
}
