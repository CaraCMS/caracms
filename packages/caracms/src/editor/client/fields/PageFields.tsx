/**
 * A section builder's page fields (M6c G2): the collection's own `fields`, beside the
 * page's blocks (a game's tile details, the header's "side"). One group at the document
 * level, under the block list and above SEO, open by default (they're the
 * page's content, where SEO falls back to the site's defaults). Sidebar
 * only: nothing here is on the page, so nothing is picked from it.
 *
 * Closed, it carries a warning mark when any page field (a group's fields too) is warned
 * (the editor-friction batch, item 5): the section a group field is drawn as
 * (GroupField.tsx → FieldSection), so the two look and behave the same.
 *
 * The values live in the document store beside the blocks (`PAGE_SCOPE`,
 * document-store.ts), picked at the document level as `page.<path>` (so they never ring
 * the page's blocks), and are written as the file's top-level keys (serialize.ts).
 */
import { useMemo } from 'react';
import { titleCase, type Field } from '../../../fields.ts';
import { useEditor, useStore } from '../context.tsx';
import type { Editor, View } from '../editor.ts';
import { pageFieldsLabel } from '../documents/actions.ts';
import { PAGE_SCOPE } from '../state/document-store.ts';
import { formRows } from '../pane/levels/FormLevel.tsx';
import { FieldControl } from './FieldControl.tsx';
import { FieldSection, useReveal } from './GroupField.tsx';
import { fieldsWarnings, FieldHostProvider, parseBase, useWarningContext, type FieldHost } from './host.tsx';

const PREFIX = `${PAGE_SCOPE}.`;

/** The page fields' host: picked at the document level as `page.<path>`. */
function pageHost(editor: Editor, raw: Record<string, unknown> | undefined, readOnly: boolean): FieldHost {
	return {
		scope: PAGE_SCOPE,
		picked: (view: View) => (view.level === 'document' && view.field?.startsWith(PREFIX) ? view.field.slice(PREFIX.length) : null),
		pick(path) {
			if (editor.view.get().field !== `${PREFIX}${path}`) editor.view.update({ field: `${PREFIX}${path}`, picked: false });
		},
		set: (path, value, options) => editor.doc.setField(PAGE_SCOPE, path, value, options),
		removeItem(path, index, label) {
			editor.doc.removeItem(PAGE_SCOPE, path, index, { label });
			editor.announce(`${label}. Undo with Command Z.`);
		},
		raw: (name) => (raw && Object.hasOwn(raw, name) ? raw[name] : undefined),
		readOnly,
	};
}

/** The group, for the open section builder; null when its collection has no page fields. */
export function PageFields() {
	const editor = useEditor();
	const ref = useStore(editor.doc.state, (s) => s.ref);
	const base = useStore(editor.doc.state, (s) => s.base);
	const data = useStore(editor.doc.state, (s) => s.document.data);
	const readOnly = useStore(editor.access, (a) => a.readOnly);
	const context = useWarningContext();
	// A path picked inside (Publish's list of images without alt text) opens the section.
	const reveal = useReveal((v) => (v.level === 'document' && v.field?.startsWith(PREFIX) ? v.field : null));
	const raw = useMemo(() => {
		const parsed = parseBase(base);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	}, [base]);
	const host = useMemo(() => pageHost(editor, raw, readOnly), [editor, raw, readOnly]);
	const collection = editor.site.collections.find((c) => c.name === ref.collection);
	const fields = collection?.kind === 'sections' ? collection.fields : null;
	const warned = useMemo(() => (fields && data ? fieldsWarnings(fields, data, raw, context).length : 0), [fields, data, raw, context]);
	if (!collection || !fields || !data) return null;
	return (
		<FieldSection label={pageFieldsLabel(collection)} className="page-fields" warnings={warned} reveal={reveal} data={{ 'data-page-fields': '' }}>
			<FieldHostProvider host={host}>
				{formRows(fields).map((row) => {
					const control = ([name, field]: [string, Field]) => <FieldControl key={`${PAGE_SCOPE}:${name}`} name={name} label={field.label ?? titleCase(name)} field={field} value={data[name]} />;
					return row.length === 2 ? (
						<div key={`${PAGE_SCOPE}:${row[0]![0]}+`} className="two">
							{row.map(control)}
						</div>
					) : (
						control(row[0]!)
					);
				})}
			</FieldHostProvider>
		</FieldSection>
	);
}
