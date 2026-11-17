/**
 * An unknown block's panel (the mockup's #unknown, its unknownPanel; Decisions 7
 * and 21), for the block level to show in place of fields when the open block's
 * type isn't in the site's config:
 *
 *   {block.known ? <fields…/> : <UnknownBlockPanel block={block} />}
 *
 * It says the block is kept in the file and skipped on the page, lists what's kept
 * (its top-level keys, each with a short preview of its value), and offers Remove,
 * with Undo. It can't be edited.
 */
import { useEditor, useStore } from '../context.tsx';
import { Icon } from '../shell/Icons.tsx';
import type { EditorBlock } from '../../types.ts';
import { keptSummary, sharedOf } from './summary.ts';
import { sharedEntryOf } from '../../../document.ts';

export function UnknownBlockPanel({ block }: { block: EditorBlock }) {
	const editor = useEditor();
	const readOnly = useStore(editor.access, (a) => a.readOnly);
	const documents = useStore(editor.documents);
	const kept = keptSummary(block.data);
	const remove = () => {
		editor.doc.removeBlock(block.key);
		editor.goTo('document');
		editor.announce('Removed Unknown block. Undo with Command Z.');
	};
	const removeEntry = () => {
		editor.doc.removeBlock(block.key, { label: `Removed ${sharedOf(editor.site, documents, block)?.label ?? 'shared block'}` });
		editor.goTo('document');
		editor.announce('Removed the shared block from this page. Undo with Command Z.');
	};
	// A shared-block entry (M5a Decision 8): selected, moved and removed like a block, never
	// edited here. One that renders offers its own document (the mockup's #shared panel).
	const entry = sharedEntryOf(block);
	const shared = entry !== undefined ? sharedOf(editor.site, documents, block) : null;
	if (shared) {
		const used = (shared.usedOn ?? []).map((u) => documents.find((d) => d.collection === u.collection && d.path === u.path)?.label ?? u.path);
		const n = used.length;
		return (
			<div className="panel" data-shared-entry={entry} data-shared-panel="">
				<h3>{shared.label} is a shared block</h3>
				<p>Edit it in Shared blocks; it's on every page that uses it.</p>
				<div className="used">
					{used.map((t, i) => (
						<span key={`${i}:${t}`} className="chip shared">
							{t}
						</span>
					))}
				</div>
				<div className="acts">
					<button type="button" className="btn ink" data-act="edit-shared" onClick={() => void editor.openDocument({ collection: 'shared', path: shared.path })}>
						<Icon name="shared" size="sm" />
						Edit {shared.label} (used on {n} page{n === 1 ? '' : 's'})
					</button>
					<button type="button" className="btn" disabled={readOnly} onClick={removeEntry}>
						Remove from this page
					</button>
				</div>
			</div>
		);
	}
	if (entry !== undefined) {
		// Skipped on the page (Phase 2's warning): no such shared block, or a type the code doesn't know.
		const listedShared = documents.find((d) => d.collection === 'shared' && d.path === entry && !d.warning);
		const name = listedShared?.label ?? entry;
		// Edit in context, Decision 2: a header's or footer's block isn't a block of the body.
		const slot = listedShared?.slot;
		return (
			<div data-unknown-block={block.key} data-shared-entry={entry} data-slot-entry={slot}>
				<div className="note warn">
					<Icon name="warn" />
					<div>
						<b>{slot ? `${name} is the page's ${slot}, so it isn't a block of the body.` : !listedShared ? `There's no shared block "${entry}"` : `${name}'s type isn't in the site's code any more`}</b>
						<p>Skipped on the page; kept in the file.</p>
					</div>
				</div>
				<div className="panel">
					<div className="acts">
						<button type="button" className="btn" disabled={readOnly} onClick={remove}>
							Remove from this page
						</button>
					</div>
				</div>
			</div>
		);
	}
	return (
		<div data-unknown-block={block.key}>
			<div className="note warn">
				<Icon name="warn" />
				<div>
					<b>This block's type isn't in the site's code any more</b>
					<p>
						<span className="mono">{block.type || 'No type'}</span> is skipped on the page; kept in the file.
					</p>
				</div>
			</div>
			<div className="panel">
				<h3>What's kept</h3>
				{kept.length ? (
					<dl className="kept">
						{kept.map((k) => (
							<div key={k.key}>
								<dt>{k.label}</dt>
								<dd>{k.preview}</dd>
							</div>
						))}
					</dl>
				) : (
					<p>Nothing but its type.</p>
				)}
				<div className="acts">
					<button type="button" className="btn" disabled={readOnly} onClick={remove}>
						Remove block
					</button>
				</div>
			</div>
		</div>
	);
}
