/**
 * Edit in context: the lines a form gets from what the page it's shown on drew (pure rules in
 * pane/from-page.ts). Both read the preview's desktop frame again after every load and morph.
 *
 * - `<AlsoShows blockKey>` (Decision 4, Acceptance 16a): a block (or a shared block, or a fields
 *   document) whose render marked Site Settings' fields says "Also shows from Site Settings:
 *   Phone, Email, Social links · Open", Open showing Site Settings over the page. Nothing when
 *   it marked none, and never on Site Settings' own form.
 * - `<ReadRows blockKey>` (Decision 12, Acceptance 17): "Shows entries from Case studies (4) ·
 *   Open" for each collection the block listed (Open: that collection's level), and a row for
 *   each document it read alone that its own reference fields don't hold (Open: that document
 *   over the page). Only while the preview shows the block's own page: the read record keys
 *   the page's blocks.
 */
import { useEffect, useState } from 'react';
import { own } from '../../../document.ts';
import { SETTINGS_PATH } from '../../../reserved.ts';
import { useEditor, useStore } from '../context.tsx';
import type { Editor } from '../editor.ts';
import { Icon } from '../shell/Icons.tsx';
import { docIcon } from '../nav/DocRow.tsx';
import { singular } from '../documents/actions.ts';
import { formFields } from '../state/schema.ts';
import { contextRoots } from '../preview/markers.ts';
import { ownCtxs } from '../preview/places.ts';
import { sameDoc } from '../../types.ts';
import { formsShown, heldRefs, notFormWord, readRecordOf, readRows, settingsMarks, settingsShown } from './from-page.ts';

/** Site Settings › Forms with one form's group open and in view, once the form has rendered (review gaps, Decision 9). */
function revealForm(id: string, tries = 12): void {
	const group = document.querySelector<HTMLDetailsElement>(`[data-pane-level="document"] details[data-form-words="${CSS.escape(id)}"]`);
	if (!group) {
		if (tries > 0) requestAnimationFrame(() => revealForm(id, tries - 1));
		return;
	}
	group.open = true;
	group.scrollIntoView({ block: 'start' });
}

/** The preview's desktop frame's document, read again after each load and morph. */
function usePreviewDocument(editor: Editor): Document | null {
	const [, setTick] = useState(0);
	useEffect(() => {
		const preview = editor.preview;
		if (!preview) return;
		const bump = () => setTick((t) => t + 1);
		const offLoad = preview.onLoad(bump);
		const offMorph = preview.onMorph(bump);
		return () => {
			offLoad();
			offMorph();
		};
	}, [editor]);
	return editor.preview?.frames().find((f) => f.document)?.document ?? null;
}

export function AlsoShows({ blockKey }: { blockKey: string }) {
	const editor = useEditor();
	const session = useStore(editor.doc.state);
	const showing = useStore(editor.previewStatus, (s) => s.showing);
	const doc = usePreviewDocument(editor);
	if (!doc || session.ref.collection === 'settings') return null;
	// A form's words have their own row (ReadRows), not a label each here.
	const labels = settingsShown(settingsMarks(contextRoots(doc, ownCtxs(session, showing, blockKey))).filter(notFormWord), formFields(editor.site, 'settings'));
	if (!labels.length) return null;
	return (
		<div className="fixed-line also-shows" data-also-shows="settings">
			<Icon name="gear" size="sm" />
			<span>
				Also shows from Site Settings: {labels.join(', ')} ·{' '}
				<button type="button" className="linkbtn" data-act="open-settings" onClick={() => void editor.openOver({ collection: 'settings', path: SETTINGS_PATH })}>
					Open
				</button>
			</span>
		</div>
	);
}

export function ReadRows({ blockKey }: { blockKey: string }) {
	const editor = useEditor();
	const session = useStore(editor.doc.state);
	const showing = useStore(editor.previewStatus, (s) => s.showing);
	const documents = useStore(editor.documents);
	const doc = usePreviewDocument(editor);
	const index = session.document.blocks.findIndex((b) => b.key === blockKey);
	const block = session.document.blocks[index];
	if (!doc || !block || !sameDoc(showing, session.ref)) return null;
	const fields = session.document.kind === 'fields' ? formFields(editor.site, session.ref.collection) : (own(editor.site.blocks, block.type)?.fields ?? {});
	const rows = readRows(readRecordOf(doc), index, heldRefs(fields, block.data));
	// Review gaps (Decision 9): a form it draws, whose words are Site Settings' (the mockup's "Words from" row).
	const forms = formsShown(settingsMarks(contextRoots(doc, ownCtxs(session, showing, block.key)))).flatMap((id) => editor.forms.filter((f) => f.id === id));
	if (!rows.length && !forms.length) return null;
	return (
		<div className="reads" role="group" aria-label="What this block shows from elsewhere" data-reads="">
			{forms.map((form) => (
				<div key={`words:${form.id}`} className="read" data-read={`words:${form.id}`}>
					<Icon name="gear" />
					<span className="t">
						Words from <b>Site Settings › Forms › {form.label}</b>
					</span>
					<button type="button" className="btn sm" aria-label={`Open the ${form.label} form’s words in Site Settings`} onClick={() => void editor.openOver({ collection: 'settings', path: SETTINGS_PATH }).then(() => revealForm(form.id))}>
						Open
						<Icon name="chev-r" size="xs" />
					</button>
				</div>
			))}
			{rows.map((row) => {
				const collection = editor.site.collections.find((c) => c.name === row.collection);
				const label = collection?.label ?? row.collection;
				if (row.kind === 'list') {
					return (
						<div key={`list:${row.collection}`} className="read" data-read={row.collection}>
							<Icon name={docIcon(collection)} />
							<span className="t">
								Shows entries from <b>{label}</b> <span className="n">({row.count})</span>
							</span>
							<button type="button" className="btn sm" aria-label={`Open ${label}`} onClick={() => editor.openCollection(row.collection)}>
								Open
								<Icon name="chev-r" size="xs" />
							</button>
						</div>
					);
				}
				const listed = documents.find((d) => d.collection === row.collection && d.path === row.path);
				const title = listed?.label ?? row.path;
				return (
					<div key={`doc:${row.collection}/${row.path}`} className="read" data-read={`${row.collection}/${row.path}`}>
						<Icon name={docIcon(collection)} />
						<span className="t">
							Shows <b>{title}</b> <span className="n">· {collection ? singular(collection) : row.collection}</span>
						</span>
						<button type="button" className="btn sm" aria-label={`Open ${title}`} onClick={() => void editor.openOver({ collection: row.collection, path: row.path })}>
							Open
							<Icon name="chev-r" size="xs" />
						</button>
					</div>
				);
			})}
		</div>
	);
}
