/**
 * M9 Decision 7: the page's "Hidden from the site" switch, at the document level under its
 * page fields and above SEO. It's the toggle field's switch (SimpleFields.tsx →
 * ToggleField), set through `editor.doc.setHidden`, so it saves and publishes like any edit.
 *
 * - Only on a section builder's page with an address, and never on the home page (`index`),
 *   which can't be hidden.
 * - A page under a hidden page is hidden with it (content.ts → `hiddenBy`): the switch shows
 *   on and can't be turned off here, and its help names the page to show again.
 * - Collections under pages (Decision 5): a page that holds a collection says so beside it,
 *   "Holds Journal (24)" (every document, hidden ones included). Nothing here changes it:
 *   the `holds` line is the file's, a developer's call.
 */
import { useMemo } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { FieldFrame } from './FieldFrame.tsx';
import { FieldHostProvider, type FieldHost } from './host.tsx';
import { docIcon } from '../nav/DocRow.tsx';
import { Icon } from '../shell/Icons.tsx';

const SCOPE = 'page-hidden';
const NAME = 'hidden';

export function HiddenToggle() {
	const editor = useEditor();
	const ref = useStore(editor.doc.state, (s) => s.ref);
	const kind = useStore(editor.doc.state, (s) => s.document.kind);
	const hidden = useStore(editor.doc.state, (s) => !!s.document.hidden);
	const documents = useStore(editor.documents);
	const readOnly = useStore(editor.access, (a) => a.readOnly);
	const host = useMemo<FieldHost>(
		() => ({ scope: SCOPE, picked: () => null, pick() {}, set: (_path, value) => editor.doc.setHidden(value === true), removeItem() {}, raw: () => undefined, readOnly }),
		[editor, readOnly],
	);
	const collection = editor.site.collections.find((c) => c.name === ref.collection);
	if (kind !== 'sections' || !collection?.urlBase || ref.path === 'index') return null;
	const listed = documents.find((d) => d.collection === ref.collection && d.path === ref.path);
	// Collections under pages (Decision 11): a held document is hidden with the page that holds its collection.
	const byCollection = listed?.hiddenByCollection ?? ref.collection;
	const by = listed?.hiddenBy ? documents.find((d) => d.collection === byCollection && d.path === listed.hiddenBy) : undefined;
	const on = hidden || !!by;
	const holds = listed?.holds ? editor.site.collections.find((c) => c.name === listed.holds && c.heldBy === ref.collection) : undefined;
	const id = `f-${SCOPE}-${NAME}`;
	const help = by
		? `Hidden with ${by.label}, the page ${listed?.hiddenByCollection ? `that holds ${collection.label}` : "it's under"}. Show that page again to show this one.`
		: 'Visitors get the 404 page, and it’s left out of the sitemap and the link picker. You can still edit, preview and publish it.';
	return (
		<div className="page-hidden" data-page-hidden={on ? 'on' : 'off'}>
			<FieldHostProvider host={host}>
				<FieldFrame blockKey={SCOPE} name={NAME} label="Hidden from the site" help={help} htmlFor={id}>
					<button type="button" className="switch" role="switch" id={id} data-path={NAME} aria-checked={on} disabled={readOnly || !!by} onClick={() => host.set(NAME, !hidden)}>
						<span className="track" />
						<span>{on ? 'On' : 'Off'}</span>
					</button>
				</FieldFrame>
			</FieldHostProvider>
			{holds ? (
				<p className="page-holds" data-holds={holds.name}>
					<Icon name={docIcon(holds)} size="xs" />
					<span>
						Holds {holds.label} ({documents.filter((d) => d.collection === holds.name).length})
					</span>
				</p>
			) : null}
		</div>
	);
}
