/**
 * The add-block picker (the mockup's #picker): on the document level, in place of
 * the block list, while `pickerAt(editor)` holds an index (link.ts → openPicker).
 * The site's block types, each with its fields; picking one adds an empty block of
 * that type at the index and opens it. Back, or Esc, returns to the list.
 *
 * M5a: the Shared blocks section inserts a shared block's entry (`{ "shared": name }`),
 * not a copy (Decision 8).
 *
 * Edit in context, Decision 2: a slot's block type (a header, a footer) is never offered,
 * nor a shared block of one: it fills the page's frame by itself, never its body.
 */
import { own } from '../../../document.ts';
import { useEffect, useRef } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { Icon } from '../shell/Icons.tsx';
import { blockLabel } from '../state/document-store.ts';
import { offeredBlocks, offersBlock } from '../state/schema.ts';
import { CurrentHead, DocumentsTab, GlobalNotes, LevelTab, RecentStrip, Trail } from '../pane/parts.tsx';
import { closePicker } from './link.ts';
import { blockIcon, fieldsSummary, sharedOf, usedOnLine } from './summary.ts';

export function Picker({ at }: { at: number }) {
	const editor = useEditor();
	const blocks = useStore(editor.doc.state, (s) => s.document.blocks);
	const title = useStore(editor.doc.state, (s) => s.document.title || s.entry.label);
	const documents = useStore(editor.documents);
	const collection = useStore(editor.doc.state, (s) => s.ref.collection);
	const body = useRef<HTMLDivElement>(null);
	const before = blocks[at - 1];
	const n = blocks.length;

	useEffect(() => {
		body.current?.querySelector<HTMLElement>('.ptype')?.focus();
		// Esc closes the picker, before App.tsx's Esc would go up a level.
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.defaultPrevented || editor.view.get().pop) return;
			event.preventDefault();
			closePicker(editor);
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, [editor]);

	// The collection's offered blocks (config.ts `blocks`), else every block.
	const offered = offeredBlocks(editor.site, collection);
	const types = (offered ? offered.map((type) => own(editor.site.blocks, type)).filter((b) => !!b) : Object.values(editor.site.blocks)).filter((b) => !b.slot);
	// M5a Decision 8: the shared blocks that render (their type is one the site knows), of a type the collection offers.
	const shared = documents.filter(
		(d) => d.collection === 'shared' && !d.warning && !!d.blockType && !!own(editor.site.blocks, d.blockType) && !own(editor.site.blocks, d.blockType)!.slot && offersBlock(editor.site, collection, d.blockType),
	);
	const pickShared = (name: string, label: string) => {
		const key = editor.doc.addShared(name, at);
		closePicker(editor);
		editor.openBlock(key);
		editor.announce(`Added ${label}, a shared block`);
	};

	const pick = (type: string) => {
		const key = editor.doc.addBlock(type, at);
		closePicker(editor);
		editor.openBlock(key);
		editor.announce(`Added ${own(editor.site.blocks, type)?.label ?? type}`);
	};

	return (
		<>
			<Trail>
				<DocumentsTab />
				<LevelTab name={title} kind="Blocks" count={`${n} block${n === 1 ? '' : 's'}`} onClick={() => closePicker(editor)} />
				<CurrentHead
					back={{ label: `Back to ${title}`, onClick: () => closePicker(editor) }}
					crumb={title}
					title="Add a block"
					sub={before ? `After ${sharedOf(editor.site, documents, before)?.label ?? blockLabel(editor.site, before)}` : n ? 'At the top of the page' : 'The first block on the page'}
				/>
			</Trail>
			<div className="side-body" ref={body} data-picker-at={at}>
				<GlobalNotes />
				<p className="sec-h">Blocks</p>
				<div className="picker-grid">
					{types.map((schema) => (
						<button key={schema.type} type="button" className="ptype" data-type={schema.type} onClick={() => pick(schema.type)}>
							<span className="sk">
								<Icon name={blockIcon({ type: schema.type, known: true })} />
							</span>
							<b>{schema.label}</b>
							<small>{fieldsSummary(schema)}</small>
						</button>
					))}
				</div>
				{shared.length ? (
					<>
						<p className="sec-h" data-section="shared-blocks">
							Shared blocks
						</p>
						{shared.map((d) => (
							<button key={d.path} type="button" className="drow" data-shared={d.path} onClick={() => pickShared(d.path, d.label)}>
								<Icon name="shared" />
								<span className="nm">{d.label}</span>
								<span className="meta">{usedOnLine(d)}</span>
							</button>
						))}
					</>
				) : null}
			</div>
			<RecentStrip />
		</>
	);
}
