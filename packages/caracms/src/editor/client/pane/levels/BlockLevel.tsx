/**
 * The block level (Phase 3; the mockup's blockView): one block's fields, with the
 * levels you came from stacked above, and back. (The "1 of 5" stepper went in the
 * pre-M7 polish: the block list and the preview are how you move between blocks.)
 *
 * The fields (Decision 12), each in a field frame (fields/FieldFrame.tsx): text,
 * one line or several (also typed on the page), the lockup (main lines, phone
 * lines, the warnings; edited here only) and select; and M5a's (Decision 2): rich
 * text, link, buttons, toggle, number, date, list and reference, all edited here
 * (M5a Decision 13). They're mounted through a field host (fields/host.tsx), the
 * same way a fields document's form mounts them. On Phone, a block with a lockup
 * says that changes show at every width, except a heading's phone lines.
 *
 * An unknown block (Decision 21) shows Phase 4's panel: what's kept, and Remove.
 *
 * A field is changed with `editor.doc.setField(key, field, value)`; the preview
 * re-renders and the keeper writes it (document-store.ts).
 */
import { useMemo, type ReactNode } from 'react';
import { own } from '../../../../document.ts';
import { titleCase } from '../../../../fields.ts';
import { UnknownBlockPanel } from '../../block-list/UnknownBlock.tsx';
import { sharedOf } from '../../block-list/summary.ts';
import { useEditor, useStore } from '../../context.tsx';
import { FieldControl } from '../../fields/FieldControl.tsx';
import { blockHost, FieldHostProvider, rawBlock } from '../../fields/host.tsx';
import { Icon } from '../../shell/Icons.tsx';
import { blockLabel } from '../../state/document-store.ts';
import { CurrentHead, DocumentsTab, GlobalNotes, LevelTab, RecentStrip, Trail } from '../parts.tsx';
import { DocNotices, ReadOnlyChip } from '../../live/notices.tsx';
import { AlsoShows, ReadRows } from '../FromPage.tsx';

export function BlockLevel() {
	const editor = useEditor();
	const session = useStore(editor.doc.state);
	const key = useStore(editor.view, (v) => v.block);
	const width = useStore(editor.view, (v) => v.width);
	// Under a lock, with held edits, or signed out: every field disabled (M4 Decision 9; the mockup's #locked-block).
	const readOnly = useStore(editor.access, (a) => a.readOnly);
	const documents = useStore(editor.documents);
	const { document, entry } = session;
	const index = document.blocks.findIndex((b) => b.key === key);
	const block = document.blocks[index];
	const raw = block ? rawBlock(session.base, block.source) : undefined;
	const host = useMemo(() => (key ? blockHost(editor, key, raw, readOnly) : null), [editor, key, raw, readOnly]);
	if (!block || !host) return null;
	const n = document.blocks.length;
	const title = document.title || entry.label;
	// A shared entry that renders (M5a Decision 8) is named by its shared block, and marked Shared.
	const shared = sharedOf(editor.site, documents, block);
	const nameOf = (b: typeof block) => sharedOf(editor.site, documents, b)?.label ?? blockLabel(editor.site, b);
	const fields = block.known ? Object.entries(own(editor.site.blocks, block.type)?.fields ?? {}) : [];
	// A lockup at the top level or inside a group (`left.heading`).
	const hasLockup = fields.some(([, f]) => f.kind === 'lockup' || (f.kind === 'group' && Object.values(f.fields).some((g) => g.kind === 'lockup')));
	return (
		<>
			<Trail>
				<DocumentsTab />
				<LevelTab name={title} kind="Blocks" count={`${n} block${n === 1 ? '' : 's'}`} onClick={() => editor.goTo('document')} />
				<CurrentHead
					back={{ label: `Back to ${title}`, onClick: () => editor.goTo('document') }}
					crumb={title}
					title={nameOf(block)}
					chips={
						<>
							{shared ? <span className="chip shared">Shared</span> : null}
							<ReadOnlyChip />
						</>
					}
				/>
			</Trail>
			<div className="side-body block-level" data-block-key={block.key}>
				<GlobalNotes />
				<DocNotices />
				{width === 'phone' && hasLockup && !readOnly ? (
					<div className="note phone">
						<Icon name="phone" />
						<div>
							<p>Changes show at every width, except a heading's phone lines.</p>
						</div>
					</div>
				) : null}
				{!block.known ? (
					<UnknownBlockPanel block={block} />
				) : (
					<Fields live={editor.mode === 'live'} readOnly={readOnly}>
						{/* M6c (G8): the block's own help, at the top of its level. */}
						<BlockHelp help={own(editor.site.blocks, block.type)?.help} />
						{/* Edit in context, Decision 12: "Shows entries from Case studies (4) · Open", above its fields. */}
						<ReadRows blockKey={block.key} />
						{/* Review gaps (Decision 7): its other states, switched over the page. */}
						{shared ? null : <StatesLine type={block.type} />}
						{fields.length === 0 ? <p className="field-help">This block has nothing to set.</p> : null}
						<FieldHostProvider host={host}>
							{fields.map(([name, field]) => (
								<FieldControl key={`${block.key}:${name}`} name={name} label={field.label ?? titleCase(name)} field={field} value={block.data[name]} lockupIndex={index} />
							))}
						</FieldHostProvider>
						{/* Decision 4: what its render shows from Site Settings. */}
						<AlsoShows blockKey={block.key} />
					</Fields>
				)}
			</div>
			<RecentStrip />
		</>
	);
}

/**
 * Review gaps (Decision 7): a block with states names them at the top of its level ("Also shows
 * Sent, Couldn't send and Invalid."), saying they're switched over the page and never saved.
 */
export function StatesLine({ type }: { type: string }) {
	const editor = useEditor();
	const states = Object.values(own(editor.site.blocks, type)?.states ?? {});
	if (!states.length) return null;
	const named = states.length === 1 ? states[0] : `${states.slice(0, -1).join(', ')} and ${states[states.length - 1]}`;
	return (
		<div className="states-line" data-states-line="">
			<Icon name="layers" size="sm" />
			<span>
				<b>Also shows {named}.</b> Switch between them over the page to see and edit each. Only the preview changes; nothing is saved.
			</span>
		</div>
	);
}

/** M6c (G8): a block's help (its config's `help`), plain text at the top of its sidebar level. */
export function BlockHelp({ help }: { help: string | undefined }) {
	return help ? (
		<p className="field-help block-help" data-block-help="">
			{help}
		</p>
	) : null;
}

/**
 * The fields' wrapper. Live mode (M4 Decision 9): a fieldset with no box of its own,
 * disabled while the document is read-only, so every control in it is. Local mode: no
 * wrapper, as in M3.
 */
function Fields({ live, readOnly, children }: { live: boolean; readOnly: boolean; children: ReactNode }) {
	if (!live) return <>{children}</>;
	return (
		<fieldset className="ro-fields" disabled={readOnly} data-read-only={readOnly ? '' : undefined}>
			{children}
		</fieldset>
	);
}
