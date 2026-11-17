/**
 * Rich text's block commands for a list item that is a textblock (on-page rich
 * text, Decision 3: `<li>` holds its text directly, as `richTextHtml` renders it).
 * Tiptap's list commands assume `li > p` and silently do nothing here, so these
 * replace them. Plain ProseMirror commands (`(state, dispatch) => boolean`) so the
 * keys, the sidebar's toolbar and the page's bar all run the same ones, and node
 * tests can run them on an `EditorState`; `toggleList` and `setBlockStyle` also
 * take a Tiptap `Editor`.
 *
 * - **splitListItem** (Enter in an item): a new item; in an empty item, the item
 *   leaves the list as a paragraph (M5a → Resolved decisions, Google Docs).
 * - **liftListItem** (Backspace at an item's start, and the above): the item, alone,
 *   leaves its list as a paragraph; the list splits around it.
 * - **toggleList**: paragraphs and headings in the selection become items of that
 *   kind of list (joined to a list of that kind just before or after); in a list of
 *   that kind, the selected items leave it as paragraphs; in the other kind, the
 *   whole list changes kind.
 * - **setBlockStyle** (the style menu): the selection's blocks become that style;
 *   a list item leaves its list as that style, the list splitting around it
 *   (Decision 9).
 */
import type { Editor } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode, type NodeType } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { canJoin, ReplaceAroundStep } from '@tiptap/pm/transform';

export type Command = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean;
export type ListKind = 'bulletList' | 'orderedList';
export type BlockStyle = 'p' | 'h2' | 'h3';

const isList = (node: PMNode) => node.type.name === 'bulletList' || node.type.name === 'orderedList';

/** The top-level blocks the selection touches: each with its position in the doc. */
function blocksInSelection(state: EditorState): { node: PMNode; pos: number }[] {
	const { from, to } = state.selection;
	const out: { node: PMNode; pos: number }[] = [];
	state.doc.forEach((node, pos) => {
		if (pos + node.nodeSize > from && pos <= to) out.push({ node, pos });
	});
	return out;
}

/** The items of `list` (at `listPos`) the range [from, to] touches, with their positions. */
function itemsInRange(list: PMNode, listPos: number, from: number, to: number): number[] {
	const out: number[] = [];
	list.forEach((item, offset) => {
		const pos = listPos + 1 + offset;
		if (pos + item.nodeSize > from && pos <= to) out.push(pos);
	});
	return out;
}

/**
 * Takes the items at `positions` (each the position before a listItem, in `tr.doc`)
 * out of their lists as `type` blocks, splitting each list around them. Works from
 * the last to the first, so the earlier positions stay valid.
 */
function liftItems(tr: Transaction, positions: readonly number[], type: NodeType, attrs: Record<string, unknown> | null) {
	for (const pos of [...positions].sort((a, b) => b - a)) {
		const $pos = tr.doc.resolve(pos);
		const list = $pos.parent;
		const index = $pos.index();
		const item = list.child(index);
		let start = pos;
		if (index < list.childCount - 1) tr.split(start + item.nodeSize, 1);
		if (index > 0) {
			tr.split(start, 1);
			start += 2;
		}
		// Now the item is alone in a list at start - 1: replace the list and the item with one block holding its text.
		const listStart = start - 1;
		const listEnd = start + item.nodeSize + 1;
		tr.step(new ReplaceAroundStep(listStart, listEnd, start + 1, start + item.nodeSize - 1, new Slice(Fragment.from(type.create(attrs)), 0, 0), 1, true));
	}
}

/** Wraps the top-level textblock at `pos` (in `tr.doc`) as one item of a new list of `listType`. */
function wrapAsItem(tr: Transaction, pos: number, listType: NodeType) {
	const node = tr.doc.nodeAt(pos)!;
	const item = tr.doc.type.schema.nodes.listItem!;
	tr.step(new ReplaceAroundStep(pos, pos + node.nodeSize, pos + 1, pos + node.nodeSize - 1, new Slice(Fragment.from(listType.create(null, item.create())), 0, 0), 2, true));
}

/** Joins every pair of adjacent lists of `listType` between `from` and `to` (in `tr.doc`). */
function joinAdjacent(tr: Transaction, listType: NodeType, from: number, to: number) {
	const joins: number[] = [];
	let prev: PMNode | null = null;
	tr.doc.forEach((node, pos) => {
		if (prev && prev.type === listType && node.type === listType && pos >= from && pos <= to) joins.push(pos);
		prev = node;
	});
	for (const pos of joins.reverse()) if (canJoin(tr.doc, pos)) tr.join(pos);
}

/** Enter in a list item: a new item; in an empty one, it leaves the list as a paragraph. */
export const splitListItem: Command = (state, dispatch) => {
	const { $from } = state.selection;
	if ($from.parent.type.name !== 'listItem') return false;
	if ($from.parent.content.size === 0 && state.selection.empty) return liftListItem(state, dispatch);
	if (dispatch) {
		const tr = state.tr;
		if (!state.selection.empty) tr.deleteSelection();
		const marks = state.storedMarks || (tr.selection.$to.parentOffset ? tr.selection.$from.marks() : null);
		tr.split(tr.selection.from, 1);
		if (marks) tr.ensureMarks(marks);
		dispatch(tr.scrollIntoView());
	}
	return true;
};

/** Backspace at an item's start (and Enter in an empty one): the item leaves its list as a paragraph. */
export const liftListItem: Command = (state, dispatch) => {
	const { $from } = state.selection;
	if ($from.parent.type.name !== 'listItem') return false;
	if (dispatch) {
		const tr = state.tr;
		liftItems(tr, [$from.before()], state.schema.nodes.paragraph!, null);
		dispatch(tr.scrollIntoView());
	}
	return true;
};

/** The list button: on, off, or the other kind (see the header). */
export function toggleListCommand(kind: ListKind): Command {
	return (state, dispatch) => {
		const listType = state.schema.nodes[kind];
		if (!listType) return false;
		const { from, to } = state.selection;
		const blocks = blocksInSelection(state);
		if (!blocks.length) return false;
		const allThisKind = blocks.every((b) => b.node.type === listType);
		if (!dispatch) return true;
		const tr = state.tr;
		if (allThisKind) {
			const items = blocks.flatMap((b) => itemsInRange(b.node, b.pos, from, to));
			liftItems(tr, items, state.schema.nodes.paragraph!, null);
		} else {
			// From the last block to the first, so earlier positions stay valid.
			for (const b of [...blocks].reverse()) {
				if (b.node.type === listType) continue;
				if (isList(b.node)) tr.setNodeMarkup(b.pos, listType);
				else if (b.node.isTextblock) wrapAsItem(tr, b.pos, listType);
			}
			const first = blocks[0]!.pos;
			const last = blocks[blocks.length - 1]!;
			const end = tr.mapping.map(last.pos + last.node.nodeSize);
			joinAdjacent(tr, listType, first, end);
		}
		dispatch(tr.scrollIntoView());
		return true;
	};
}

/** The style menu: the selection's blocks become `style`; a list item leaves its list as it. */
export function setBlockStyleCommand(style: BlockStyle): Command {
	return (state, dispatch) => {
		const type = style === 'p' ? state.schema.nodes.paragraph! : state.schema.nodes.heading;
		if (!type) return false;
		const attrs = style === 'p' ? null : { level: style === 'h2' ? 2 : 3 };
		const { from, to } = state.selection;
		const blocks = blocksInSelection(state);
		if (!blocks.length) return false;
		if (!dispatch) return true;
		const tr = state.tr;
		const items = blocks.filter((b) => isList(b.node)).flatMap((b) => itemsInRange(b.node, b.pos, from, to));
		liftItems(tr, items, type, attrs);
		tr.setBlockType(tr.mapping.map(from), tr.mapping.map(to), type, attrs);
		dispatch(tr.scrollIntoView());
		return true;
	};
}

const run = (editor: Editor, command: Command) => {
	const ok = command(editor.state, editor.view.dispatch);
	if (ok) editor.view.focus();
	return ok;
};

/** The list button on a Tiptap editor (the sidebar's toolbar, the page's bar). Focuses the editor. */
export const toggleList = (editor: Editor, kind: ListKind): boolean => run(editor, toggleListCommand(kind));

/** The style menu on a Tiptap editor: Paragraph, Heading 2 or Heading 3. Focuses the editor. */
export const setBlockStyle = (editor: Editor, style: BlockStyle): boolean => run(editor, setBlockStyleCommand(style));
