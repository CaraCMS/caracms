/**
 * The document level: the open document's blocks (the mockup's #blocks, #picker,
 * #removed, #drag, #unknown, #empty-page). The block list is client/block-list/
 * BlockList.tsx; the add-block picker (Picker.tsx) takes this level's place while
 * it's open; an empty page invites adding the first block.
 *
 * A nested page shows its parent in front of its title ("Services / Branding").
 * The page menu: View on the live site, Delete page… (documents/DocMenu.tsx; M5a).
 *
 * M5a: a list-of-fields document, a shared block and Site Settings are forms, each
 * with its own level (FormLevel.tsx); this picks by the document's kind.
 */
import { useEditor, useStore } from '../../context.tsx';
import { Icon } from '../../shell/Icons.tsx';
import { BlockList } from '../../block-list/BlockList.tsx';
import { openPicker, pickerAt } from '../../block-list/link.ts';
import { Picker } from '../../block-list/Picker.tsx';
import { CurrentHead, DocumentsTab, GlobalNotes, parentLabel, RecentStrip, Trail } from '../parts.tsx';
import { DocNotices, ReadOnlyChip } from '../../live/notices.tsx';
import { DocMenu, TitleNote } from '../../documents/DocMenu.tsx';
import { PagesUnder } from '../../documents/PagesUnder.tsx';
import { FieldsDocumentLevel, SettingsLevel, SharedDocumentLevel } from './FormLevel.tsx';
import { SeoGroup } from '../../fields/SeoGroup.tsx';
import { HiddenToggle } from '../../fields/HiddenToggle.tsx';
import { PageFields } from '../../fields/PageFields.tsx';
import { FramePickers } from '../../fields/FramePickers.tsx';

/** The open document's level, by its kind (M5a): a section builder's blocks, or a form. */
export function DocumentLevel() {
	const editor = useEditor();
	const kind = useStore(editor.doc.state, (s) => s.document.kind);
	if (kind === 'fields') return <FieldsDocumentLevel />;
	if (kind === 'shared') return <SharedDocumentLevel />;
	if (kind === 'settings') return <SettingsLevel />;
	return <SectionsLevel />;
}

function SectionsLevel() {
	const editor = useEditor();
	const ref = useStore(editor.doc.state, (s) => s.ref);
	const entry = useStore(editor.doc.state, (s) => s.entry);
	const title = useStore(editor.doc.state, (s) => s.document.title || s.entry.label);
	const empty = useStore(editor.doc.state, (s) => s.document.blocks.length === 0);
	const documents = useStore(editor.documents);
	const picking = useStore(pickerAt(editor));
	const readOnly = useStore(editor.access, (a) => a.readOnly);
	const waiting = useStore(editor.liveState, (s) => s.status?.waiting);
	if (picking !== null) return <Picker at={picking} />;
	const collection = editor.site.collections.find((c) => c.name === ref.collection);
	const url = entry.url ?? '';
	const isNew = (waiting ?? []).some((w) => w.collection === ref.collection && w.path === ref.path && w.change === 'new' && !w.movedFrom);
	return (
		<>
			<Trail>
				<DocumentsTab />
				<CurrentHead
					back={{ label: 'Back to documents', onClick: () => editor.goTo('documents') }}
					crumb={collection?.nested ? parentLabel(ref, documents) : collection?.label}
					title={title}
					sub={
						<>
							{/* The crumb and the tabs say what kind of document it is; only its state gets a chip, under the title so it never clips. */}
							{isNew ? <span className="chip waiting">New</span> : null}
							<ReadOnlyChip />
							{/* The path alone: the host is the same on every page. */}
							<span className="mono">{url || '/'}</span>
						</>
					}
					menu={<DocMenu label="Page actions" />}
				/>
			</Trail>
			<div className="side-body" data-document={`${ref.collection}/${ref.path}`}>
				<GlobalNotes />
				<DocNotices />
				<TitleNote />
				{empty ? (
					<div className="empty" data-empty="page" style={{ padding: 'var(--space-4)' }}>
						<b>No blocks yet</b>
						<button type="button" className="btn ink" style={{ marginTop: 'var(--space-2)' }} disabled={readOnly} onClick={() => openPicker(editor, 0)}>
							<Icon name="plus" size="sm" />
							Add the first block
						</button>
					</div>
				) : (
					<BlockList />
				)}
				{/* M6c (G2): the page's own fields, when its collection has some, under its blocks. */}
				<PageFields />
				{/* M9 Decision 7: hidden from the site, or not. */}
				<HiddenToggle />
				{/* Edit in context, Decision 3: its header and footer, when the site has more than one. */}
				<FramePickers />
				{/* M6 Decision 13: the page's own SEO, under its blocks. */}
				<SeoGroup />
				<PagesUnder />
			</div>
			<RecentStrip />
		</>
	);
}
