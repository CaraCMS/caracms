/**
 * The docs kit's screenshot: a picture from the site's media, what it should show, and an
 * optional caption.
 *
 * Stored, with a picture:
 *   { "type": "screenshot", "image": { "key": "uploads/…/posts.png", "alt": "…" },
 *     "capture": "The Posts screen with the New post button", "caption": "…" }
 * Stored, still to capture (the image left out):
 *   { "type": "screenshot", "capture": "The Posts screen with the New post button" }
 *
 * `capture` ("What to capture") says what the picture shows: the brief while it's empty and
 * the alt text's starting point once it's there (`altFrom: 'capture'`: a picture placed with no
 * alt of its own starts with these words; the render also falls back to them when the alt is
 * empty, for pictures placed before the option). Empty, the block draws nothing for
 * visitors and a "Screenshot to add: …" placeholder in the editor's preview.
 */
import { media, text, type BlockConfig, type BlockData } from 'caracms/config';

export const screenshotBlock = {
	label: 'Screenshot',
	component: 'src/starlight-kit/blocks/Screenshot.astro',
	fields: {
		image: media({ label: 'Picture', only: 'image', altFrom: 'capture' }),
		capture: text({ label: 'What to capture', help: 'What the picture shows. Visitors never see this; it starts the picture’s alt text.' }),
		caption: text({ label: 'Caption' }),
	},
} satisfies BlockConfig;

export type ScreenshotData = BlockData<typeof screenshotBlock.fields>;
