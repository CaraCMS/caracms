import { defineSite, richText, text, type BlockConfig } from 'caracms/config';

/**
 * `caracms audit`'s Starlight fixture. What it should print, once its pages render:
 * - unmarked: Home › Note's `credit` (drawn, unmarked), never its `body` (marked inside Starlight's <Aside>).
 * - unheld: the note's credit, the sidebar's group label "Guides" (written in Page.astro) and
 *   Starlight's own words ("Skip to content", "Next", "On this page"…); never a page's title (its
 *   <h1>, the sidebar's links, prev/next) nor a heading's words in the table of contents.
 */
const note = {
	label: 'Note',
	component: 'src/blocks/Note.astro',
	fields: { body: text({ label: 'Text' }), credit: text({ label: 'Credit' }) },
} satisfies BlockConfig;

const textBlock = {
	label: 'Text',
	component: 'src/blocks/Text.astro',
	fields: { body: richText({ label: 'Text', headings: ['h2'] }) },
} satisfies BlockConfig;

export default defineSite({
	collections: { pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true } },
	blocks: { note, text: textBlock },
	textStyles: {},
	page: 'src/components/Page.astro',
});
