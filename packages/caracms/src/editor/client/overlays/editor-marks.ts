/**
 * The editor's own overlay marks (M2 → Overlays), drawn into the shared layer on the
 * `editor` channel, from the editor's state:
 *
 *   selected      the open block (the block level): 2px, a filled tag with its type
 *   hover         the block under the pointer on the page, or its row in the block list
 *                 (block-list/link.ts → blockHover, which this also sets from the page)
 *   field-hover   a field under the pointer inside the open block
 *   picked        the picked field, ringed with its name; teal "· Phone lines" in the
 *                 phone frame when the lockup has its own phone lines
 *   typing        the field being typed on the page: "Typing on the page" (rich text: the
 *                 ring alone, its formatting bar sits there; rich-text-bar.ts)
 *   warn          a lockup too long for mobile, in the phone frame (previewStatus.warnings)
 *   skipped       an unknown block, where it would be on the page; its pill opens it. A
 *                 shared-block entry (M5a Decision 8) only when the listing has no such
 *                 shared block: one that exists renders on the page (its own screen is Phase 5's)
 *
 *
 * Edit in context:
 *   open          a document open over the page: a faint ring round what it draws there
 *                 (the footer, a card; Site Settings' own fields, never the footer round them)
 *   picked/typing its field, the chip naming it first ("Footer › Columns"); held by someone
 *                 else, the lock's grey and "Read-only · Aoife is editing" (Decision 14)
 *   field-hover   another document's field in the frame, its chip naming it ("Site Settings › Phone")
 *   page fields   the page's own (`page.<path>`): picked, typing, hover, named alone (Decision 10a)
 *
 * None while the preview shows another document than the sidebar (one is opening), except
 * the page under a document open over it, which gets only that document's marks.
 */
import { blockHover, setBlockHover } from '../block-list/link.ts';
import type { Editor } from '../editor.ts';
import type { PageEdit } from '../preview/page-edit.ts';
import { blockLabel } from '../state/document-store.ts';
import { fieldAt, fieldAtPath, getAtPath, titleCase } from '../../../fields.ts';
import { own, sharedEntryOf } from '../../../document.ts';
import { sameDoc, type DocRef, type EditorBlock } from '../../types.ts';
import { displayName } from '../live/format.ts';
import { formKey, PAGE_SCOPE } from '../state/document-store.ts';
import { ownCtxs, pageFieldPath } from '../preview/places.ts';
import type { Ctx } from '../preview/markers.ts';
import type { Fields } from '../../../fields.ts';
import { FORM_WORDS_KEY } from '../../../forms/words.ts';
import { fieldsOfBlock } from '../state/schema.ts';
import type { Mark, Overlays, StateSwitch } from './layer.ts';
import { createStore, type Store } from '../state/store.ts';

export const EDITOR_CHANNEL = 'editor';

/**
 * The name a picked field is ringed with. A dotted path (M5a Decision 16) names the
 * field and the item: `credits.1.name` → "Credits 2 · Name", `cta.label` → "Cta",
 * `left.heading` (a group's field) → "Left · Heading".
 */
export function fieldLabel(fields: Fields | undefined, field: string): string {
	const schema = fields ? { fields } : undefined;
	const descriptor = schema ? own(schema.fields, field) : undefined;
	if (descriptor || !field.includes('.')) return descriptor?.label ?? titleCase(field);
	const [top, index, sub] = field.split('.');
	const outer = schema ? own(schema.fields, top!) : undefined;
	const name = outer?.label ?? titleCase(top!);
	// A field in a group: `left.heading` → "Left · Heading".
	if (outer?.kind === 'group' && index !== undefined && Object.hasOwn(outer.fields, index)) return `${name} · ${fieldLabel(outer.fields, field.slice(top!.length + 1))}`;
	if (!/^\d+$/.test(index ?? '')) return name;
	const inner = schema && sub ? fieldAtPath(schema.fields, field) : undefined;
	const subName = sub && inner && inner.rest.length === 0 && inner.field !== outer ? (inner.field.label ?? titleCase(sub)) : null;
	return subName ? `${name} ${Number(index) + 1} · ${subName}` : `${name} ${Number(index) + 1}`;
}

/**
 * A field of a source as its chip names it after the source (edit in context's mockup): a list's
 * row by the list's label ("Columns", "Social links"), a group's field by its own ("Phone").
 */
export function sourceFieldLabel(fields: Fields | undefined, field: string): string {
	if (field.startsWith(`${FORM_WORDS_KEY}.`)) {
		const words = formWordLabel(fields, field);
		if (words) return words;
	}
	const [top, ...rest] = field.split('.');
	const descriptor = fields ? own(fields, top!) : undefined;
	if (descriptor?.kind === 'group' && rest.length) return sourceFieldLabel(descriptor.fields, rest.join('.'));
	return descriptor?.label ?? titleCase(top!);
}

/**
 * Review gaps: a form's word names its whole path, as the mockup's #word-label and #word-sent do:
 * "Forms › Contact › Your name", "Forms › Contact › Your name › Placeholder", "Forms › Contact ›
 * Sent: heading". Null when the path isn't one of the generated fields (word-fields.ts).
 */
function formWordLabel(fields: Fields | undefined, field: string): string | null {
	const [root, form, part, name, word, option] = field.split('.');
	const forms = fields ? own(fields, root!) : undefined;
	const group = forms?.kind === 'group' ? own(forms.fields, form!) : undefined;
	if (!forms || group?.kind !== 'group') return null;
	const head = `${forms.label ?? 'Forms'} › ${group.label ?? titleCase(form!)}`;
	if (part === 'fields') {
		const all = own(group.fields, 'fields');
		const one = all?.kind === 'group' ? own(all.fields, name!) : undefined;
		if (one?.kind !== 'group') return null;
		const leaf = word ? own(one.fields, word) : undefined;
		if (!leaf) return null;
		if (word === 'label') return `${head} › ${one.label ?? titleCase(name!)}`;
		if (word === 'options' && leaf.kind === 'group') {
			const o = option ? own(leaf.fields, option) : undefined;
			return o ? `${head} › ${one.label ?? titleCase(name!)} › ${o.label ?? option}` : null;
		}
		return `${head} › ${one.label ?? titleCase(name!)} › ${leaf.label ?? titleCase(word)}`;
	}
	const leaf = fieldAtPath(group.fields, field.split('.').slice(2).join('.'));
	return leaf && leaf.rest.length === 0 ? `${head} › ${leaf.field.label ?? titleCase(part!)}` : null;
}

/** A document's name on the page's chips: "Site Settings", a shared block's or an entry's title. */
export function documentName(editor: Editor, ref: DocRef): string {
	if (editor.site.collections.find((c) => c.name === ref.collection)?.kind === 'settings') return 'Site Settings';
	const session = editor.doc.get();
	if (sameDoc(session.ref, ref)) return session.document.title || session.entry.label;
	return editor.documents.get().find((d) => d.collection === ref.collection && d.path === ref.path)?.label ?? ref.path;
}

/** The fields a document's source marks address (descriptor.ts → fieldsOf): a shared block's type's, else its collection's. */
export function sourceFields(editor: Editor, ref: DocRef): Fields | undefined {
	const collection = editor.site.collections.find((c) => c.name === ref.collection);
	if (!collection) return undefined;
	if (collection.kind === 'shared') {
		const session = editor.doc.get();
		const type = sameDoc(session.ref, ref) ? session.document.blocks[0]?.type : editor.documents.get().find((d) => d.collection === ref.collection && d.path === ref.path)?.blockType;
		return type ? own(editor.site.blocks, type)?.fields : undefined;
	}
	return ('fields' in collection ? (collection.fields as Fields | undefined) : undefined) ?? undefined;
}

/** The page fields' descriptors of the open section builder, if any. */
const pageFieldsOf = (editor: Editor): Fields | undefined => {
	const ref = editor.doc.get().ref;
	const collection = editor.site.collections.find((c) => c.name === ref.collection);
	return collection?.kind === 'sections' ? (collection.fields ?? undefined) : undefined;
};

/** Review gaps (Decision 7): whether the folded state switch's menu is open, per editor. */
const stateMenus = new WeakMap<Editor, Store<boolean>>();
function stateMenu(editor: Editor): Store<boolean> {
	let menu = stateMenus.get(editor);
	if (!menu) stateMenus.set(editor, (menu = createStore(false)));
	return menu;
}

/**
 * Review gaps (Decision 7): the switch for the block at `index` of the page shown, of type `type`,
 * or null when its type has no states. Its first option is the block's first look ("First look").
 */
function stateSwitch(editor: Editor, type: string, index: number, quiet: boolean): StateSwitch | null {
	const schema = own(editor.site.blocks, type);
	if (!schema?.states) return null;
	const chosen = editor.blockState.get();
	const showing = editor.previewStatus.get().showing;
	const mine = chosen && chosen.block === index && sameDoc(chosen.page, showing) ? chosen : null;
	const menu = stateMenu(editor);
	return {
		options: [{ key: null, label: 'First look' }, ...Object.entries(schema.states).map(([key, label]) => ({ key, label }))],
		chosen: mine?.name ?? null,
		waiting: !!mine?.waiting,
		quiet,
		menu: menu.get(),
		name: `Show the ${schema.label} block as`,
		choose: (key) => editor.showState(index, key),
		toggleMenu: (open) => menu.set(open),
	};
}

/** Edit in context (Decision 8): the marks while the open document is shown over a page. */
function overMarks(editor: Editor, pageEdit: PageEdit): Mark[] {
	const session = editor.doc.get();
	const view = editor.view.get();
	const status = editor.previewStatus.get();
	const access = editor.access.get();
	const sections = session.document.kind === 'sections';
	const key = sections ? PAGE_SCOPE : formKey(session);
	const at: readonly Ctx[] = key ? ownCtxs(session, status.showing, key) : [];
	if (!key || !at.length) return [];
	const marks: Mark[] = [{ kind: 'open', block: -1, at }];
	const name = documentName(editor, session.ref);
	const fields = sourceFields(editor, session.ref);
	// Held by someone else (Decision 14): the chip says so in place of the field's name, in the lock's grey.
	const holder = access.readOnly && access.lock === 'theirs' && access.holder ? `${displayName(access.holder.person)} is editing` : access.readOnly ? 'Read-only' : null;
	const named = (field: string): Pick<Mark, 'label' | 'source' | 'icon' | 'tone'> =>
		holder ? { label: holder === 'Read-only' ? holder : `Read-only · ${holder}`, icon: 'lock', tone: 'ro' } : { label: sourceFieldLabel(fields, field), source: name };
	const field = sections ? (view.level === 'document' && view.field?.startsWith(pageFieldPath('')) ? view.field.slice(pageFieldPath('').length) : null) : editor.fieldsOpen(view) && view.block === key ? view.field : null;
	const typing = pageEdit.typing.get();
	const hover = pageEdit.hover.get();
	if (hover?.key === key && hover.field && hover.field !== field) marks.push({ kind: 'field-hover', block: -1, at, field: hover.field, ...(holder ? { tone: 'ro' as const } : {}) });
	if (field) marks.push({ kind: typing && typing.key === key && typing.field === field ? 'typing' : 'picked', block: -1, at, field, ...named(field) });
	// Review gaps (Decision 7): the page's block with states it was left on keeps its switch, quietly, so a
	// state's words stay in view while they're edited here (a form word opens Site Settings over the page).
	const over = editor.over.get();
	const left = over?.block ?? null;
	const type = left !== null ? pageBlockType(editor, left) : undefined;
	const states = type ? stateSwitch(editor, type, left!, true) : null;
	if (states) marks.push({ kind: 'states', block: left!, label: own(editor.site.blocks, type!)?.label, states });
	return marks;
}

/** The type of the page's own block at `index` under the open document, from its marker in the preview (never a shared entry's). */
function pageBlockType(editor: Editor, index: number): string | undefined {
	const doc = editor.preview?.frames()[0]?.document;
	const el = doc?.querySelector<HTMLElement>(`[data-cms-block="${index}"]:not([data-cms-shared])`);
	return el?.dataset.cmsType ?? undefined;
}

/** The marks for the editor's state now. Pure apart from reading the stores. */
export function editorMarks(editor: Editor, pageEdit: PageEdit): Mark[] {
	const status = editor.previewStatus.get();
	const session = editor.doc.get();
	if (status.opening) return [];
	const over = editor.over.get();
	if (over && sameDoc(status.showing, over.page) && !sameDoc(over.page, session.ref)) return overMarks(editor, pageEdit);
	if (!sameDoc(status.showing, session.ref)) return [];
	const view = editor.view.get();
	const blocks = session.document.blocks;
	const marks: Mark[] = [];
	/** Where a block (or a form) of the open document is drawn: by index, and a footer's own preview in its slot. */
	const atOf = (index: number): readonly Ctx[] | undefined => {
		const key = blocks[index]?.key;
		return key && session.document.kind === 'shared' ? ownCtxs(session, status.showing, key) : undefined;
	};

	const listed = editor.documents.get();
	const sharedExists = (name: string) => listed.some((d) => d.collection === 'shared' && d.path === name && !d.warning && d.blockType && own(editor.site.blocks, d.blockType));
	/** A block's tag: its type's label, or a shared entry's shared block's title (M5a). */
	const entryLabel = (block: EditorBlock) => {
		const shared = sharedEntryOf(block);
		return shared !== undefined ? (listed.find((d) => d.collection === 'shared' && d.path === shared)?.label ?? shared) : blockLabel(editor.site, block);
	};
	blocks.forEach((block, index) => {
		if (block.known) return;
		const shared = sharedEntryOf(block);
		if (shared !== undefined && sharedExists(shared)) return;
		marks.push({
			kind: 'skipped',
			block: index,
			label: shared !== undefined ? `Skipped on the page: shared block ${shared}` : `Skipped on the page: ${block.type || 'no type'}`,
			onClick: () => editor.openBlock(block.key),
		});
	});

	// The selected block is outlined in the block level and in the block list it's selected in
	// (the mockup's #blocks and #picker); its fields' marks only while it's open.
	// A form (a fields document, a shared block, Site Settings: M5a) has no block list: its
	// fields' marks show at its document level, and no block is outlined as selected.
	const form = session.document.kind !== 'sections';
	// M5b: a slot's picker (the library in place of the block's fields) keeps the block selected and the slot ringed.
	const picking = view.level === 'media' && !!view.media?.pick;
	const inList = !form && (view.level === 'block' || view.level === 'document' || picking);
	const inBlock = editor.fieldsOpen(view) || picking;
	const selectedIndex = form ? (inBlock ? 0 : -1) : inList && view.block ? session.document.blocks.findIndex((b) => b.key === view.block) : -1;
	const selected = selectedIndex >= 0 ? blocks[selectedIndex]! : null;
	if (selected && !form && (selected.known || sharedExists(sharedEntryOf(selected) ?? ''))) {
		// Review gaps (Decision 7): a block with states has its switch beside its tag (the tag moves into the switch's row).
		const states = selected.known && sharedEntryOf(selected) === undefined ? stateSwitch(editor, selected.type, selectedIndex, false) : null;
		marks.push({ kind: 'selected', block: selectedIndex, ...(states ? {} : { label: entryLabel(selected) }) });
		if (states) marks.push({ kind: 'states', block: selectedIndex, label: entryLabel(selected), states });
	}
	// A shared block's own render (its block is the document's one): the switch at its root, offered there too.
	if (form && session.document.kind === 'shared' && inBlock && blocks[0]?.known) {
		const states = stateSwitch(editor, blocks[0].type, 0, false);
		const at0 = atOf(0);
		if (states) marks.push({ kind: 'states', block: 0, label: blockLabel(editor.site, blocks[0]), states, ...(at0 ? { at: at0 } : {}) });
	}

	const hoverKey = blockHover(editor).get();
	const hoverIndex = hoverKey ? blocks.findIndex((b) => b.key === hoverKey) : -1;
	const hovered = hoverIndex >= 0 ? blocks[hoverIndex]! : null;
	if (hovered && !form && (hovered.known || sharedExists(sharedEntryOf(hovered) ?? '')) && hoverIndex !== selectedIndex) marks.push({ kind: 'hover', block: hoverIndex, label: entryLabel(hovered) });

	const pageHover = pageEdit.hover.get();
	const at = selectedIndex >= 0 ? atOf(selectedIndex) : undefined;
	const where = (mark: Mark): Mark => (at ? { ...mark, at } : mark);
	if (inBlock && selected?.known && pageHover && pageHover.key === selected.key && pageHover.field && pageHover.field !== view.field) {
		marks.push(where({ kind: 'field-hover', block: selectedIndex, field: pageHover.field }));
	}

	// Edit in context: another document's field under the pointer in the frame is named after it (Acceptance 9).
	const source = pageHover?.source;
	if (source && source.inBlock === null && source.fieldEl && source.field) {
		const id = source.ref.collection === 'settings' ? 'settings' : `${source.ref.collection}/${source.ref.path}`;
		marks.push({ kind: 'field-hover', block: -1, at: [{ kind: 'source', id }], field: source.field, label: sourceFieldLabel(sourceFields(editor, source.ref), source.field), source: documentName(editor, source.ref) });
	}

	// The page's own fields (Decision 10a): picked in Page details as `page.<path>`, named alone.
	const pageFields = pageFieldsOf(editor);
	const prefix = pageFieldPath('');
	if (pageFields && session.document.kind === 'sections') {
		const pagePick = view.level === 'document' && view.field?.startsWith(prefix) ? view.field.slice(prefix.length) : null;
		const typingPage = pageEdit.typing.get();
		const here: readonly Ctx[] = [{ kind: 'page' }];
		if (pageHover?.key === PAGE_SCOPE && pageHover.field && pageHover.field !== pagePick) marks.push({ kind: 'field-hover', block: -1, at: here, field: pageHover.field });
		if (pagePick) {
			const typed = typingPage?.key === PAGE_SCOPE && typingPage.field === pagePick;
			const descriptor = fieldAt(pageFields, pagePick);
			marks.push({ kind: typed ? 'typing' : 'picked', block: -1, at: here, field: pagePick, label: typed ? (descriptor?.kind === 'richText' ? undefined : 'Typing on the page') : fieldLabel(pageFields, pagePick) });
		}
	}

	if (inBlock && selected?.known && view.field) {
		const field = view.field;
		const fields = fieldsOfBlock(editor.site, session.document, session.ref.collection, selected);
		const label = fieldLabel(fields, field);
		const typing = pageEdit.typing.get();
		const descriptor = fieldAt(fields, field);
		// A field warned in the phone frame shows the amber "Too long for mobile" tag there,
		// not its own name too (the mockup's #phone-main): its ring stays, its tag goes.
		const warned = status.warnings.some((w) => w.tooLong && w.block === selectedIndex && w.field === field);
		const phone = (mark: Mark): Mark => (warned ? { ...mark, label: undefined } : mark);
		if (typing && typing.key === selected.key && typing.field === field) {
			// Rich text keeps the ring but not its chip: the formatting bar sits there (on-page rich text, Decision 9).
			marks.push(where({ kind: 'typing', block: selectedIndex, field, label: descriptor?.kind === 'richText' ? undefined : 'Typing on the page' }));
		} else if (descriptor?.kind === 'lockup' && hasPhoneLines(getAtPath(selected.data, field))) {
			marks.push(where({ kind: 'picked', block: selectedIndex, field, label, frames: ['desktop', 'tablet'] }));
			marks.push(where(phone({ kind: 'picked', block: selectedIndex, field, label: `${label} · Phone lines`, tone: 'phone', frames: ['phone'] })));
		} else if (warned) {
			marks.push(where({ kind: 'picked', block: selectedIndex, field, label, frames: ['desktop', 'tablet'] }));
			marks.push(where(phone({ kind: 'picked', block: selectedIndex, field, label, frames: ['phone'] })));
		} else {
			marks.push(where({ kind: 'picked', block: selectedIndex, field, label }));
		}
	}

	for (const warning of status.warnings) {
		if (warning.tooLong) marks.push({ kind: 'warn', block: warning.block, field: warning.field, label: 'Too long for mobile', frames: ['phone'] });
	}
	return marks;
}

const hasPhoneLines = (value: unknown) => !!value && typeof value === 'object' && Array.isArray((value as { phone?: unknown }).phone) && (value as { phone: unknown[] }).phone.length > 0;

/** Keep the `editor` channel up to date. Returns a stop. */
export function startEditorMarks(editor: Editor, overlays: Overlays, pageEdit: PageEdit): () => void {
	const update = () => overlays.set(EDITOR_CHANNEL, editorMarks(editor, pageEdit));
	const hover = blockHover(editor);
	const stops = [
		editor.view.subscribe(update),
		editor.doc.state.subscribe(update),
		editor.previewStatus.subscribe(update),
		pageEdit.typing.subscribe(update),
		pageEdit.hover.subscribe(update),
		hover.subscribe(update),
		editor.over.subscribe(update),
		editor.access.subscribe(update),
		editor.documents.subscribe(update),
		editor.blockState.subscribe(update),
		stateMenu(editor).subscribe(update),
		// The page's hover lights up the block's row in the list too (and the list's, the page).
		pageEdit.hover.subscribe((now, before) => {
			if (now?.block === before?.block) return;
			const key = now && now.block >= 0 ? (editor.doc.keyAt(now.block) ?? null) : null;
			if (now || hover.get() === (before && before.block >= 0 ? editor.doc.keyAt(before.block) : null)) setBlockHover(editor, key);
		}),
	];
	update();
	return () => {
		for (const stop of stops) stop();
		overlays.clear(EDITOR_CHANNEL);
	};
}
