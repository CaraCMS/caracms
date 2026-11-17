/**
 * A page's own pages, under its SEO group: the pages whose addresses start
 * with its own, indented as in the Pages tree and in its order, each opening as it
 * does there. Open to begin with; a page with none shows nothing.
 */
import { useState } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { DocRow } from '../nav/DocRow.tsx';
import { Icon } from '../shell/Icons.tsx';
import { openDialog } from './dialogs.tsx';
import { pagesUnder } from './actions.ts';

export function PagesUnder() {
	const editor = useEditor();
	const ref = useStore(editor.doc.state, (s) => s.ref);
	const label = useStore(editor.doc.state, (s) => s.document.title || s.entry.label);
	const documents = useStore(editor.documents);
	const [open, setOpen] = useState(true);
	const collection = editor.site.collections.find((c) => c.name === ref.collection);
	if (!collection?.nested || ref.path === 'index') return null;
	const under = pagesUnder(collection.name, ref.path, documents);
	if (!under.length) return null;
	const top = ref.path.split('/').length + 1;
	return (
		<details className="fgroup pages-under" open={open} data-pages-under={under.length} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
			<summary>
				Pages under {label} <span className="s">· {under.length}</span>
				<Icon name="chev-r" size="sm" />
			</summary>
			<div className="in">
				{under.map((d) => (
					<DocRow key={d.path} doc={d} className="t" style={{ ['--depth' as string]: d.path.split('/').length - top }} />
				))}
				<button type="button" className="linkbtn" data-act="new-page-under" onClick={() => openDialog(editor, { kind: 'new', collection: collection.name, inside: ref.path })}>
					<Icon name="plus" size="xs" />
					New page under {label}
				</button>
			</div>
		</details>
	);
}
