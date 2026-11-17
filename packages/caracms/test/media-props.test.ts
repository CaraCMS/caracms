// M8 trial, item 13 (the M8 trial's findings): `<Media>` takes an element's own
// attributes (`draggable` and the like), not only `data-*`. A type check: `pnpm check` (tsc)
// fails if these stop compiling; the test itself only proves the file runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MediaProps } from '../src/components/media-props.ts';
import type { BlockContext } from '../src/document.ts';

const cms = {} as BlockContext;

test("<Media>'s props take standard HTML attributes", () => {
	const props: MediaProps[] = [
		{ cms, value: null, draggable: 'false', id: 'hero-image', title: 'The harbour', 'aria-hidden': 'true', 'data-role': 'photo' },
		{ cms, value: null, field: 'media', sizes: '100vw', ratio: 3 / 2, class: 'tm-media', style: 'opacity: .9', loading: 'eager', fetchpriority: 'high', tabindex: -1 },
	];
	// @ts-expect-error a prop that isn't an attribute or one of Media's own
	const wrong: MediaProps = { cms, value: null, nonsense: 3 };
	// @ts-expect-error what the component sets itself isn't the caller's
	const own: MediaProps = { cms, value: null, src: '/x.jpg' };
	assert.equal(props.length + [wrong, own].length, 4);
});
