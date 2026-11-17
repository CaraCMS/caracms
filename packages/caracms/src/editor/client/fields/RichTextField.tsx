/**
 * Rich text (M5a Decision 3; the mockup's #rich-text, #rich-link, #rich-warn):
 * Tiptap, editor-only, in the sidebar (Decision 13), with a schema of exactly the
 * field's nodes and marks (rich-text-schema.ts: the keys, paste, no input rules).
 *
 * - **The toolbar:** the paragraph style (only when the field allows headings:
 *   Paragraph, Heading 2, and Heading 3 where allowed; never Heading 1), Bold,
 *   Italic, Bulleted list, Numbered list, and Link (when the field allows links). A heading
 *   field (M9 Decision 11) has Bold only.
 *   ⌘B, ⌘I and ⌘K do the same.
 * - **The link popover** (⌘K or the toolbar): find a document by title or address,
 *   or type an address; picking a document stores its URL (Decision 4). An address
 *   that fails the link rule says the rule's message, and is kept as typed if used.
 *   With nothing selected, picking inserts the document's title as the link's text.
 * - **What's stored** is the field's value after every change (rich-text-doc.ts →
 *   fromDoc, through Phase 1's parse), so the file gets Decision 3's format: one
 *   block per line, `**`, `*`, `[text](href)`, `\n`, literal characters escaped.
 * - **Warnings** (amber): a kind the field doesn't allow or a link where links are
 *   off (from the file, until the field is edited: quiet, with a chip in the head),
 *   a link that fails the rule or goes to a document that doesn't exist.
 *
 * Before the editor mounts (the server render, hydration), the same frame shows
 * the text as HTML, so nothing flickers in (no skeletons).
 */
import { Editor } from '@tiptap/core';
import { useEffect, useRef, useState, type FocusEvent } from 'react';
import { richTextOptions, type RichTextField as RichTextDescriptor } from '../../../fields.ts';
import { fileAddress, fileKeyOf } from '../../../files.ts';
import type { LibraryFile } from '../../types.ts';
import { richTextHtml, type RichTextValue } from '../../../rich-text.ts';
import { Icon } from '../shell/Icons.tsx';
import { FieldFrame } from './FieldFrame.tsx';
import { useFieldWarnings, useHost } from './host.tsx';
import { documentAt, FieldIcon, LinkPopover, useLinkable, Warnings } from './parts.tsx';
import { setBlockStyle, toggleList } from './rich-text-commands.ts';
import { fromDoc, toDoc, type PMNode } from './rich-text-doc.ts';
import { clipboardTextParser, richTextExtensions } from './rich-text-schema.ts';

const STYLES = [
	{ v: 'p', name: 'Paragraph', cls: 'st-p' },
	{ v: 'h2', name: 'Heading 2', cls: 'st-h2' },
	{ v: 'h3', name: 'Heading 3', cls: 'st-h3' },
] as const;

const isLinkKey = (event: KeyboardEvent) => (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';

export function RichTextField(props: { name: string; label: string; field: RichTextDescriptor; value: unknown }) {
	const host = useHost();
	const { name, field } = props;
	const id = `f-${host.scope}-${name}`.replace(/\./g, '-');
	const value = (Array.isArray(props.value) ? props.value : []) as RichTextValue;
	const options = richTextOptions(field);
	const optionsKey = `${field.headings.join(',')}|${field.links}|${!!field.heading}`;
	const linkable = useLinkable();
	const warnings = useFieldWarnings(name, field, props.value);

	const mount = useRef<HTMLDivElement>(null);
	const editorRef = useRef<Editor | null>(null);
	/** The value this field last stored (or was given): a change from outside is anything else. */
	const lastValue = useRef(JSON.stringify(value));
	const latest = useRef({ host, name, options, openLink: () => {} });
	const [initialHtml] = useState(() => `<div class="prose rt">${richTextHtml(value)}</div>`);
	const [, setTick] = useState(0);
	const [link, setLink] = useState<{ query: string; editing: boolean } | null>(null);
	const [styleMenu, setStyleMenu] = useState(false);

	const openLink = () => {
		const ed = editorRef.current;
		if (!ed || !field.links || !ed.isEditable) return;
		const href = ed.getAttributes('link').href as string | undefined;
		setStyleMenu(false);
		setLink({ query: href ?? '', editing: href !== undefined });
	};
	latest.current = { host, name, options, openLink };

	useEffect(() => {
		const el = mount.current;
		if (!el) return;
		el.textContent = '';
		const ed = new Editor({
			element: el,
			extensions: richTextExtensions(latest.current.options),
			content: toDoc(JSON.parse(lastValue.current) as RichTextValue, latest.current.options),
			injectCSS: false,
			enableInputRules: false,
			enablePasteRules: false,
			editable: !latest.current.host.readOnly,
			editorProps: {
				attributes: {
					class: 'prose rt',
					role: 'textbox',
					'aria-multiline': 'true',
					'aria-labelledby': `${id}-l`,
					'data-path': name,
				},
				clipboardTextParser,
				handleKeyDown(_view, event) {
					if (!isLinkKey(event)) return false;
					// ⌘K is the link here, not the document switcher (App.tsx listens on window).
					event.preventDefault();
					event.stopPropagation();
					latest.current.openLink();
					return true;
				},
			},
			onUpdate: ({ editor }) => {
				const next = fromDoc(editor.getJSON() as PMNode, latest.current.options);
				const json = JSON.stringify(next);
				if (json === lastValue.current) return;
				lastValue.current = json;
				latest.current.host.set(latest.current.name, next);
			},
			onTransaction: () => setTick((t) => t + 1),
		});
		editorRef.current = ed;
		setTick((t) => t + 1);
		return () => {
			ed.destroy();
			editorRef.current = null;
		};
		// The editor is made once per field (its schema is the field's).
	}, [optionsKey, host.scope, name]);

	// A value changed from outside (Undo of a list row holding this field, a document re-read): show it.
	useEffect(() => {
		const ed = editorRef.current;
		const json = JSON.stringify(value);
		if (!ed || json === lastValue.current) return;
		lastValue.current = json;
		if (JSON.stringify(fromDoc(ed.getJSON() as PMNode, options)) !== json) ed.commands.setContent(toDoc(value, options), { emitUpdate: false });
	}, [props.value]);

	useEffect(() => {
		editorRef.current?.setEditable(!host.readOnly, false);
	}, [host.readOnly]);

	const ed = editorRef.current;
	const active = (nameOrAttrs: string, attrs?: Record<string, unknown>) => !!ed && ed.isActive(nameOrAttrs, attrs);
	const style = active('heading', { level: 2 }) ? 'h2' : active('heading', { level: 3 }) ? 'h3' : 'p';
	const allowed = STYLES.filter((s) => s.v === 'p' || field.headings.includes(s.v));
	const run = (fn: (e: Editor) => void) => {
		if (!ed) return;
		fn(ed);
	};
	const keep = (event: { preventDefault(): void }) => event.preventDefault();

	const pick = (href: string, words?: string) => {
		// M6c G4: a link to a file keeps its popover (and focus), so the text isn't focused.
		const stay = !!fileKeyOf(href);
		run((e) => {
			const inLink = e.isActive('link');
			const chain = stay ? e.chain() : e.chain().focus();
			if (e.state.selection.empty && !inLink) {
				const doc = documentAt(href, linkable);
				const text = words ?? (doc ? doc.label || doc.title : href);
				const from = e.state.selection.from;
				chain.insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }).run();
				if (stay) e.commands.setTextSelection({ from, to: from + text.length });
			} else {
				chain.extendMarkRange('link').setMark('link', { href }).run();
			}
		});
		// M6c G4: a link to a file keeps its popover, showing the file and (a PDF) New tab / Download.
		setLink(stay ? { query: href, editing: true } : null);
	};
	const pickFile = (file: LibraryFile) => pick(fileAddress(file.key), file.name);
	const closeLink = () => {
		setLink(null);
		ed?.commands.focus();
	};
	const onPopoverBlur = (event: FocusEvent<HTMLDivElement>) => {
		if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setLink(null);
	};

	const shownAsText = warnings.filter((w) => w.code === 'disallowed-kind').length;
	const quiet = warnings.filter((w) => w.code === 'disallowed-kind' || w.code === 'link-off' || w.code === 'italic-off');
	const loud = warnings.filter((w) => w.code !== 'disallowed-kind' && w.code !== 'link-off' && w.code !== 'italic-off');
	const disabled = host.readOnly;

	return (
		<FieldFrame
			blockKey={host.scope}
			name={name}
			label={props.label}
			help={props.field.help}
			labelId={`${id}-l`}
			chips={
				shownAsText ? (
					<span className="chip warn">
						<Icon name="warn" size="xs" />
						{shownAsText === 1 ? 'One block' : `${shownAsText} blocks`} shown as text
					</span>
				) : null
			}
		>
			<div className="prose-wrap" data-rich-text={name}>
				<div className="tb" role="toolbar" aria-label="Formatting">
					{field.headings.length ? (
						<>
							<button
								type="button"
								className="tb-style"
								aria-haspopup="menu"
								aria-expanded={styleMenu}
								aria-label={`Paragraph style: ${STYLES.find((s) => s.v === style)!.name}`}
								disabled={disabled}
								onMouseDown={keep}
								onClick={() => setStyleMenu(!styleMenu)}
							>
								{STYLES.find((s) => s.v === style)!.name}
								<Icon name="chev-d" size="xs" />
							</button>
							<span className="sep" aria-hidden="true" />
						</>
					) : null}
					<button type="button" aria-label="Bold" aria-pressed={active('bold')} disabled={disabled} onMouseDown={keep} onClick={() => run((e) => e.chain().focus().toggleMark('bold').run())}>
						<b>B</b>
					</button>
					{/* M9 Decision 11: a heading field is bold and line breaks only. */}
					{field.heading ? null : (
						<>
							<button type="button" aria-label="Italic" aria-pressed={active('italic')} disabled={disabled} onMouseDown={keep} onClick={() => run((e) => e.chain().focus().toggleMark('italic').run())}>
								<i className="tb-i">I</i>
							</button>
							<span className="sep" aria-hidden="true" />
							<button
								type="button"
								aria-label="Bulleted list"
								aria-pressed={active('bulletList')}
								disabled={disabled}
								onMouseDown={keep}
								onClick={() => run((e) => toggleList(e, 'bulletList'))}
							>
								<FieldIcon name="ul" size="sm" />
							</button>
							<button
								type="button"
								aria-label="Numbered list"
								aria-pressed={active('orderedList')}
								disabled={disabled}
								onMouseDown={keep}
								onClick={() => run((e) => toggleList(e, 'orderedList'))}
							>
								<FieldIcon name="ol" size="sm" />
							</button>
						</>
					)}
					{field.links ? (
						<>
							<span className="sep" aria-hidden="true" />
							<button type="button" aria-label="Link" aria-pressed={!!link || active('link')} disabled={disabled} onMouseDown={keep} onClick={() => (link ? closeLink() : openLink())}>
								<FieldIcon name="link" size="sm" />
							</button>
						</>
					) : null}
					{styleMenu ? (
						<div className="menu" role="menu" onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), setStyleMenu(false), ed?.commands.focus())}>
							{allowed.map((s) => (
								<button
									key={s.v}
									type="button"
									role="menuitemradio"
									aria-checked={style === s.v}
									onMouseDown={keep}
									onClick={() => {
										setStyleMenu(false);
										run((e) => setBlockStyle(e, s.v));
									}}
								>
									<span className={s.cls}>{s.name}</span>
									{style === s.v ? (
										<span className="k">
											<Icon name="check" size="sm" />
										</span>
									) : null}
								</button>
							))}
						</div>
					) : null}
				</div>
				<div ref={mount} className="rt-mount" suppressHydrationWarning dangerouslySetInnerHTML={{ __html: initialHtml }} />
				{link ? (
					<LinkPopover
							onBlur={onPopoverBlur}
							withFind
							query={link.query}
							onQuery={(q) => setLink({ ...link, query: q })}
							onPick={(href) => pick(href)}
							onPickFile={pickFile}
							onClose={closeLink}
							onRemove={
								link.editing
									? () => {
											run((e) => e.chain().focus().extendMarkRange('link').unsetMark('link').run());
											setLink(null);
										}
									: undefined
							}
						/>
				) : null}
			</div>
			{quiet.length ? <Warnings warnings={quiet} quiet /> : null}
			<Warnings warnings={loud} />
		</FieldFrame>
	);
}
