/**
 * The rich-text editor's schema (M5a Decision 3): Tiptap (ProseMirror) with
 * exactly the nodes and marks the field allows, and nothing else. Browser only.
 *
 * - Nodes: paragraph, heading (only when the field allows `h2` or `h2`/`h3`, and
 *   only those levels), bulletList / orderedList of listItem, hardBreak. **A list
 *   item is a textblock** (on-page rich text, Decision 3): `<li>` holds its text
 *   directly, as `richTextHtml` renders it, so the editor's DOM is the render's on
 *   the page too. No lists inside lists. Its commands: rich-text-commands.ts.
 *   Marks: bold, italic, link (only when the field allows links; it never spans
 *   into new text typed at its end).
 * - **No input rules, no paste rules, no autolink, no link-on-paste, no slash
 *   menu:** typing `**` gives two asterisks. Formatting is the toolbar, ⌘B, ⌘I and ⌘K.
 * - **The keys follow Spec → Text:** Enter is a new paragraph (in a heading, a new
 *   paragraph after it; in a list, a new item); Shift+Enter is a line break in the
 *   paragraph, heading or item. Where the table is silent, Google Docs: Enter in an
 *   empty item leaves the list; Backspace at the start of an item takes it out of
 *   the list; Backspace at the start of a heading joins it to the block above (and
 *   an empty heading at the very start becomes a paragraph).
 * - **Paste keeps only what the field allows:** HTML is read through this schema
 *   (anything else is dropped or becomes text); plain text has a blank line start a
 *   paragraph and a single newline make a break.
 * - **A heading field** (M9 Decision 11): the document is inline content (no paragraph,
 *   list or heading nodes), with bold and hardBreak only; Enter is a line break too.
 * - Undo inside the field is its own (⌘Z / ⇧⌘Z), as every text field's is (Decision 14).
 */
import { Extension, Mark, Node } from '@tiptap/core';
import { history, redo, undo } from '@tiptap/pm/history';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { isLinkHref } from '../../../links.ts';
import type { HeadingKind } from '../../../rich-text.ts';
import { liftListItem, splitListItem } from './rich-text-commands.ts';
import { pastedParagraphs, type PMNode } from './rich-text-doc.ts';

const Doc = Node.create({ name: 'doc', topNode: true, content: 'block+' });
const Text = Node.create({ name: 'text', group: 'inline' });

const Paragraph = Node.create({
	name: 'paragraph',
	group: 'block',
	content: 'inline*',
	priority: 1000,
	parseHTML: () => [{ tag: 'p' }],
	renderHTML: () => ['p', 0],
});

const heading = (levels: readonly number[]) =>
	Node.create({
		name: 'heading',
		group: 'block',
		content: 'inline*',
		defining: true,
		addAttributes: () => ({ level: { default: levels[0] ?? 2, rendered: false } }),
		parseHTML: () => levels.map((level) => ({ tag: `h${level}`, attrs: { level } })),
		renderHTML: ({ node }) => [`h${node.attrs.level as number}`, 0],
	});

const list = (name: string, tag: string) =>
	Node.create({
		name,
		group: 'block',
		content: 'listItem+',
		parseHTML: () => [{ tag }],
		renderHTML: () => [tag, 0],
	});

const ListItem = Node.create({
	name: 'listItem',
	content: 'inline*',
	defining: true,
	parseHTML: () => [
		{ tag: 'li' },
		// A pasted item holding a paragraph (Google Docs, most web pages: <li><p>…</p></li>): its text is the item's.
		// Above the paragraph's own rule (rules without a priority are 50).
		{ tag: 'li > p', skip: true, priority: 60 },
	],
	renderHTML: () => ['li', 0],
});

const HardBreak = Node.create({
	name: 'hardBreak',
	group: 'inline',
	inline: true,
	selectable: false,
	linebreakReplacement: true,
	parseHTML: () => [{ tag: 'br' }],
	renderHTML: () => ['br'],
	renderText: () => '\n',
});

const Bold = Mark.create({
	name: 'bold',
	parseHTML: () => [
		{ tag: 'strong' },
		// Google Docs wraps a paste in <b style="font-weight:normal">.
		{ tag: 'b', getAttrs: (node) => (node as HTMLElement).style.fontWeight !== 'normal' && null },
		{ style: 'font-weight=400', clearMark: (mark) => mark.type.name === 'bold' },
		{ style: 'font-weight', getAttrs: (value) => /^(bold(er)?|[5-9]\d{2,})$/.test(value as string) && null },
	],
	renderHTML: () => ['strong', 0],
});

const Italic = Mark.create({
	name: 'italic',
	parseHTML: () => [
		{ tag: 'em' },
		{ tag: 'i', getAttrs: (node) => (node as HTMLElement).style.fontStyle !== 'normal' && null },
		{ style: 'font-style=normal', clearMark: (mark) => mark.type.name === 'italic' },
		{ style: 'font-style=italic' },
	],
	renderHTML: () => ['em', 0],
});

const Link = Mark.create({
	name: 'link',
	// Typing at a link's end doesn't extend it; a link can't hold a link (a mark excludes its own type).
	inclusive: false,
	addAttributes: () => ({ href: { default: '' } }),
	parseHTML: () => [{ tag: 'a[href]', getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute('href') ?? '' }) }],
	// The editor shows a link as a link; an href that fails the rule isn't put in the DOM (it's kept in the value).
	renderHTML: ({ mark }) => ['a', { href: isLinkHref(mark.attrs.href) ? (mark.attrs.href as string) : null, 'data-href': mark.attrs.href as string }, 0],
});

/** The keys (Spec → Text) and the field's own undo. ⌘K is the component's (it must not reach the switcher). */
const Keys = () =>
	Extension.create({
		name: 'caracmsKeys',
		priority: 1000,
		addProseMirrorPlugins: () => [history()],
		addKeyboardShortcuts() {
			const editor = this.editor;
			const inItem = () => editor.state.selection.$from.parent.type.name === 'listItem';
			return {
				'Shift-Enter': () =>
					editor.commands.command(({ tr, state, dispatch }) => {
						const br = state.schema.nodes.hardBreak!;
						if (dispatch) tr.replaceSelectionWith(br.create(), false).scrollIntoView();
						return true;
					}),
				Enter: () => (inItem() ? splitListItem(editor.state, editor.view.dispatch) : false),
				Backspace: () => {
					const { empty, $from } = editor.state.selection;
					if (!empty || $from.parentOffset !== 0 || !inItem()) return false;
					return liftListItem(editor.state, editor.view.dispatch);
				},
				'Mod-b': () => editor.commands.toggleMark('bold'),
				'Mod-i': () => editor.commands.toggleMark('italic'),
				'Mod-z': () => undo(editor.state, editor.view.dispatch),
				'Shift-Mod-z': () => redo(editor.state, editor.view.dispatch),
				'Mod-y': () => redo(editor.state, editor.view.dispatch),
				// No sinking an item into a nested list, and no tab characters: Tab moves focus on.
				Tab: () => false,
			};
		},
	});

/**
 * A heading field's document (M9 Decision 11): inline content straight inside the
 * heading tag, as RichText.astro draws it, so there's no paragraph to put a `<p>` in.
 */
const InlineDoc = Node.create({ name: 'doc', topNode: true, content: 'inline*' });

/** A heading field's keys: Enter and Shift+Enter both start a new line; bold only. */
const HeadingKeys = () =>
	Extension.create({
		name: 'caracmsHeadingKeys',
		priority: 1000,
		addProseMirrorPlugins: () => [history()],
		addKeyboardShortcuts() {
			const editor = this.editor;
			const lineBreak = () =>
				editor.commands.command(({ tr, state, dispatch }) => {
					if (dispatch) tr.replaceSelectionWith(state.schema.nodes.hardBreak!.create(), false).scrollIntoView();
					return true;
				});
			return {
				'Shift-Enter': lineBreak,
				Enter: lineBreak,
				'Mod-b': () => editor.commands.toggleMark('bold'),
				'Mod-i': () => true,
				'Mod-z': () => undo(editor.state, editor.view.dispatch),
				'Shift-Mod-z': () => redo(editor.state, editor.view.dispatch),
				'Mod-y': () => redo(editor.state, editor.view.dispatch),
				Tab: () => false,
			};
		},
	});

/** Every extension the field's editor runs with. */
export function richTextExtensions(options: { headings: readonly HeadingKind[]; links: boolean; heading?: boolean }) {
	if (options.heading) return [InlineDoc, Text, HardBreak, Bold, HeadingKeys()];
	const levels = options.headings.map((h) => (h === 'h2' ? 2 : 3));
	return [
		Doc,
		Text,
		Paragraph,
		...(levels.length ? [heading(levels)] : []),
		list('bulletList', 'ul'),
		list('orderedList', 'ol'),
		ListItem,
		HardBreak,
		Bold,
		Italic,
		...(options.links ? [Link] : []),
		Keys(),
	];
}

/** Plain text pasted (Spec → Text): a blank line starts a new paragraph, a single newline is a break. In a heading (no paragraphs): each a line. */
export function clipboardTextParser(text: string, _context: unknown, _plain: boolean, view: EditorView): Slice {
	const schema = view.state.schema;
	if (!schema.nodes.paragraph) {
		const inline = pastedParagraphs(text).flatMap((nodes, i) => [...(i > 0 ? [{ type: 'hardBreak' } as PMNode] : []), ...nodes]);
		return new Slice(Fragment.fromArray(inline.map((n) => (n.type === 'hardBreak' ? schema.nodes.hardBreak!.create() : schema.text(n.text!)))), 0, 0);
	}
	const paragraphs = pastedParagraphs(text).map((inline) =>
		schema.nodes.paragraph!.create(
			null,
			inline.map((n: PMNode) => (n.type === 'hardBreak' ? schema.nodes.hardBreak!.create() : schema.text(n.text!))),
		),
	);
	return Slice.maxOpen(Fragment.fromArray(paragraphs));
}
