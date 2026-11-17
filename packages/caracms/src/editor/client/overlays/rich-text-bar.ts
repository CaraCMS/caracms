/**
 * The formatting bar of rich text typed on the page (on-page rich text, Decision 9;
 * the mockup's RT states), and the link popover it opens. Plain DOM in the overlay
 * layer of the iframe being typed in (`#cms-overlays > .cms-rt`, outside `<body>`, so
 * the morph never sees it), so focus moving between the text, the bar and the
 * popover's search never leaves that iframe: page-edit keeps the typing session on.
 *
 * - **Shown whenever the text has focus** (a caret or a selection) or focus is in the
 *   bar's popover: while page-edit's `pageEditor` has a session. Torn down with the
 *   page editor (read-only, another document, the width, the level closing).
 * - **The field's controls only:** the paragraph style (when the field allows headings:
 *   Paragraph, Heading 2, and Heading 3 where allowed), Bold, Italic, Bulleted list,
 *   Numbered list, Link (when it allows links), each with its active state. They run
 *   the sidebar's commands (rich-text-commands.ts, the schema's marks), and never take
 *   focus from the text (mousedown is prevented: the selection stays).
 * - **Placement:** above the block the caret is in (a paragraph, a heading, or a whole
 *   list), lined up with the field's left edge, 12px clear on screen; with no room
 *   above, below the block; for a block taller than the frame, by the caret's own line.
 *   **It moves only when the caret changes block**, not as you type, wrap or select,
 *   unless the block grows under it (it never covers the block being typed). Inside the
 *   frame; sizes are `calc(var(--k) * Npx)`, positions in document coordinates.
 * - **The style menu and the link popover** open on the bar's side away from the text,
 *   or past the block when there's no room that way, never over the block.
 * - **Link and ⌘K** open the popover: the sidebar's document list and search
 *   (parts.tsx → linkHits), the link rule's message under the search, an address
 *   that fails it kept if used; with nothing selected, picking inserts the document's
 *   title as the link's text (as RichTextField.tsx does). Enter picks the highlighted
 *   row; Esc (or ⌘K) closes it and returns to the text with its selection.
 * - **M6c G4 (Decision 7): File…** beside the search lists the library's files in the
 *   popover (found by name; Upload… too); picking one links the words to its address
 *   (with nothing selected, the file's name is the link's text), and the popover stays
 *   on the file: its name, type and size, and for a PDF New tab / Download (`?download`).
 * - **The linked words keep a wash** (`--select-halo`) while the popover is open:
 *   ProseMirror's selection doesn't paint once focus is in the search.
 * - **Esc order:** the menu or popover first (here), then the field, then the level
 *   (page-edit.ts, which skips an Esc this prevented).
 *
 * Layer redraws leave it alone (`data-cms-keep`, layer.ts): taking out a node that
 * holds focus would blur the popover's search and end the session.
 */
import type { Editor as TiptapEditor } from '@tiptap/core';
import { fileAddress, fileKeyOf, fileTypeOf } from '../../../files.ts';
import { validateLink } from '../../../links.ts';
import type { ListedDocument } from '../../types.ts';
import { fileSize, mediaFor } from '../media/store.ts';
import type { Editor } from '../editor.ts';
import { docIcon } from '../nav/DocRow.tsx';
import { documentAt, firstHit, linkHits, type LinkHit } from '../fields/parts.tsx';
import { setBlockStyle, toggleList, type BlockStyle } from '../fields/rich-text-commands.ts';
import type { PageEdit, PageEditorState } from '../preview/page-edit.ts';
import { KEEP, type Overlays } from './layer.ts';

const STYLES = [
	{ v: 'p', name: 'Paragraph', cls: 'st-p' },
	{ v: 'h2', name: 'Heading 2', cls: 'st-h2' },
	{ v: 'h3', name: 'Heading 3', cls: 'st-h3' },
] as const;

/** On screen, in px (× k in the frame): the frame's margin, the bar's clearance from the block, the menu's from the bar. */
const EDGE = 8;
const GAP = 12;
const MENU_GAP = 6;
const POPOVER_WIDTH = 320;

const isLinkKey = (event: KeyboardEvent) => (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** parts.tsx's extra icons (the shell's sprite doesn't have them), as markup. */
const EXTRA: Record<string, string> = {
	link: '<path d="M6.5 4.5H5a3.5 3.5 0 0 0 0 7h1.5M9.5 4.5H11a3.5 3.5 0 0 1 0 7H9.5M5.5 8h5"/>',
	ul: '<path d="M6 4h8M6 8h8M6 12h8"/><g fill="currentColor" stroke="none"><circle cx="2.8" cy="4" r="1"/><circle cx="2.8" cy="8" r="1"/><circle cx="2.8" cy="12" r="1"/></g>',
	ol: '<path d="M6.5 4h7.5M6.5 8h7.5M6.5 12h7.5M2.5 2.8l1-.6v3.3M2.2 7.2a.9.9 0 0 1 1.6.5c0 .7-1.6 1.4-1.6 2.1h1.7M2.2 11h1.5l-.8 1 .1 0a.8.8 0 1 1-.8 1"/>',
	file: '<path d="M4 1.5h5.5L12.5 4.5v10H4zM9.5 1.5v3h3M6 8.5h4M6 11h4"/>',
};

/** An icon drawn inline: the iframe can't reach /admin's sprite, so the symbol's shapes are copied from it. */
function icon(name: string): string {
	const shapes = EXTRA[name] ?? document.getElementById(name.startsWith('b-') ? name : `i-${name}`)?.innerHTML;
	return shapes ? `<svg class="cms-i" viewBox="0 0 16 16" aria-hidden="true">${shapes}</svg>` : '';
}

interface Active {
	bold: boolean;
	italic: boolean;
	link: boolean;
	list: 'ul' | 'ol' | null;
	style: BlockStyle;
}

function activeOf(ed: TiptapEditor): Active {
	return {
		bold: ed.isActive('bold'),
		italic: ed.isActive('italic'),
		link: !!ed.schema.marks.link && ed.isActive('link'),
		list: ed.isActive('bulletList') ? 'ul' : ed.isActive('orderedList') ? 'ol' : null,
		style: ed.isActive('heading', { level: 2 }) ? 'h2' : ed.isActive('heading', { level: 3 }) ? 'h3' : 'p',
	};
}

/** The bar's DOM in one frame's layer, while it shows. */
interface Shown {
	state: PageEditorState;
	doc: Document;
	win: Window;
	root: HTMLElement;
	holds: HTMLElement;
	wrap: HTMLElement;
	bar: HTMLElement;
	menu: HTMLElement | null;
	pop: HTMLElement | null;
	input: HTMLInputElement | null;
	/** The options the bar's buttons were built for. */
	built: string;
	/** Where the bar was put, and for which block (it moves when the caret changes block). */
	placed: { block: Element; index: number; mode: 'above' | 'below' | 'line'; above: boolean; left: number; top: number } | null;
	stop: () => void;
}

/** Keep the bar up to date with the page editor. Returns a stop. */
export function startRichTextBar(editor: Editor, overlays: Overlays, pageEdit: PageEdit): () => void {
	let shown: Shown | null = null;
	/** What's open from the bar. */
	let menu = false;
	/** `files`: File… is showing the library's files (M6c G4). */
	let link: { query: string; editing: boolean; files?: boolean } | null = null;
	/** The browser's file dialog is open from the popover's Upload…: its focus going elsewhere doesn't close it. */
	let choosing = false;
	/** An upload from the popover, its row while it goes. */
	let uploading: { tag: string; name: string } | null = null;
	let uploadError: string | null = null;
	const media = mediaFor(editor);
	const stopFiles = [media.files.subscribe(() => drawLinkBody()), media.uploads.subscribe(() => uploading && drawLinkBody())];

	const linkable = (): ListedDocument[] => editor.documents.get().filter((d) => typeof d.url === 'string');

	function hide() {
		const was = shown;
		shown = null;
		menu = false;
		link = null;
		if (!was) return;
		was.stop();
		was.root.remove();
	}

	function show(state: PageEditorState) {
		const frame = state.frame;
		const doc = frame.document;
		const win = frame.window;
		if (!doc || !win) return;
		let layer = overlays.layerOf(frame);
		if (!layer) {
			overlays.flush();
			layer = overlays.layerOf(frame);
		}
		if (!layer) return;
		const root = doc.createElement('div');
		root.className = 'cms-rt';
		root.setAttribute(KEEP, '');
		const holds = doc.createElement('div');
		holds.className = 'cms-holds';
		const wrap = doc.createElement('div');
		wrap.className = 'cms-rtw';
		const bar = doc.createElement('div');
		bar.className = 'cms-rtbar';
		bar.setAttribute('role', 'toolbar');
		bar.setAttribute('aria-label', 'Formatting');
		wrap.appendChild(bar);
		root.append(holds, wrap);
		layer.appendChild(root);

		// The bar's buttons never take focus from the text (the selection stays); the search does.
		const onDown = (event: MouseEvent) => {
			if (!(event.target as Element).closest?.('input')) event.preventDefault();
		};
		const onClick = (event: MouseEvent) => {
			const button = (event.target as Element).closest?.('button');
			if (!button || !shown) return;
			event.preventDefault();
			act(button as HTMLButtonElement);
		};
		wrap.addEventListener('mousedown', onDown);
		wrap.addEventListener('click', onClick);
		const ed = state.editor;
		const onChange = () => update();
		ed.on('transaction', onChange);
		ed.on('focus', onChange);
		shown = {
			state,
			doc,
			win,
			root,
			holds,
			wrap,
			bar,
			menu: null,
			pop: null,
			input: null,
			built: '',
			placed: null,
			stop() {
				wrap.removeEventListener('mousedown', onDown);
				wrap.removeEventListener('click', onClick);
				ed.off('transaction', onChange);
				ed.off('focus', onChange);
			},
		};
		update();
	}

	/** The bar's buttons, for the field's options (built once per set of options). */
	function build(s: Shown) {
		const { headings, links, heading } = s.state.options;
		const key = `${headings.join(',')}|${links}|${!!heading}`;
		if (s.built === key) return;
		s.built = key;
		const sep = '<span class="cms-rtsep" aria-hidden="true"></span>';
		const button = (cmd: string, label: string, title: string, inner: string, extra = '') =>
			`<button type="button" data-rtc="${cmd}" aria-label="${label}" title="${title}" aria-pressed="false"${extra}>${inner}</button>`;
		s.bar.innerHTML =
			(headings.length
				? `<button type="button" class="cms-st" data-rtc="style" aria-haspopup="menu" aria-expanded="false" aria-label="Paragraph style: Paragraph">Paragraph${icon('chev-d')}</button>${sep}`
				: '') +
			button('bold', 'Bold', 'Bold (⌘B)', '<b>B</b>') +
			// M9 Decision 11: a heading field is bold and line breaks only.
			(heading
				? ''
				: button('italic', 'Italic', 'Italic (⌘I)', '<i>I</i>') + sep + button('ul', 'Bulleted list', 'Bulleted list', icon('ul')) + button('ol', 'Numbered list', 'Numbered list', icon('ol'))) +
			(links ? sep + button('link', 'Link', 'Link (⌘K)', icon('link'), ' aria-haspopup="dialog"') : '');
	}

	/** Active states, what's open, where it all sits. */
	function update() {
		const s = shown;
		if (!s) return;
		const ed = s.state.editor;
		if (ed.isDestroyed) return;
		build(s);
		const a = activeOf(ed);
		const set = (cmd: string, name: string, on: boolean) => s.bar.querySelector(`[data-rtc="${cmd}"]`)?.setAttribute(name, String(on));
		set('bold', 'aria-pressed', a.bold);
		set('italic', 'aria-pressed', a.italic);
		set('ul', 'aria-pressed', a.list === 'ul');
		set('ol', 'aria-pressed', a.list === 'ol');
		set('link', 'aria-pressed', !!link || a.link);
		const style = s.bar.querySelector<HTMLElement>('[data-rtc="style"]');
		if (style) {
			const name = STYLES.find((x) => x.v === a.style)!.name;
			style.removeAttribute('aria-pressed');
			style.setAttribute('aria-expanded', String(menu));
			style.setAttribute('aria-label', `Paragraph style: ${name}`);
			// The style's name is the button's first child, a text node (the mockup's: no wrapper around it).
			const label = style.firstChild;
			if (label?.nodeType === 3 && label.textContent !== name) label.textContent = name;
		}
		drawMenu(s, a);
		place(s);
		drawHolds(s);
	}

	function drawMenu(s: Shown, a: Active) {
		if (!menu) {
			s.menu?.remove();
			s.menu = null;
			return;
		}
		const allowed = STYLES.filter((x) => x.v === 'p' || s.state.options.headings.includes(x.v));
		const html =
			allowed
				.map(
					(x) =>
						`<button type="button" role="menuitemradio" aria-checked="${a.style === x.v}" data-rtc="set" data-v="${x.v}"><span class="${x.cls}">${x.name}</span>${a.style === x.v ? `<span class="k">${icon('check')}</span>` : ''}</button>`,
				)
				.join('');
		if (!s.menu) {
			s.menu = s.doc.createElement('div');
			s.menu.className = 'cms-rtmenu';
			s.menu.setAttribute('role', 'menu');
			s.menu.setAttribute('aria-label', 'Paragraph style');
			s.wrap.appendChild(s.menu);
		}
		if (s.menu.innerHTML !== html) s.menu.innerHTML = html;
	}

	// ---- The link popover ----

	function openLink() {
		const s = shown;
		if (!s || !s.state.options.links) return;
		const ed = s.state.editor;
		const href = ed.getAttributes('link').href as string | undefined;
		menu = false;
		link = { query: href ?? '', editing: href !== undefined };
		const pop = s.doc.createElement('div');
		pop.className = 'cms-lpop';
		pop.setAttribute('role', 'dialog');
		pop.setAttribute('aria-label', 'Where the link goes');
		pop.innerHTML = `<div class="cms-top"><div class="find">${icon('search')}<input value="" placeholder="Find a page, or type an address" aria-label="Find a page, or type an address" autocomplete="off" spellcheck="false" data-link-find=""></div><button type="button" class="cms-btn" data-files="" title="Link to a file in the library">${icon('file')}File…</button></div><div class="cms-lpop-body"></div>`;
		const input = pop.querySelector<HTMLInputElement>('input[data-link-find]')!;
		// Upload…'s file input, beside the popover (not in it: its own controls are the popover's).
		s.wrap.querySelector('input[data-rt-file]')?.remove();
		const chooser = s.doc.createElement('input');
		chooser.type = 'file';
		chooser.hidden = true;
		chooser.accept = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.zip';
		chooser.setAttribute('data-rt-file', '');
		s.wrap.appendChild(chooser);
		chooser.addEventListener('change', () => {
			choosing = false;
			const file = chooser.files?.[0];
			chooser.value = '';
			if (file) void uploadFromPopover(file);
		});
		// A link to a file opens on the file (its name, and for a PDF how it opens).
		input.value = fileKeyOf(link.query) && link.editing ? '' : link.query;
		input.addEventListener('input', () => {
			if (!link) return;
			link = link.files ? { ...link, files: true } : { ...link, query: input.value };
			drawLinkBody();
			place(shown!);
		});
		input.addEventListener('keydown', (event) => {
			if (event.isComposing) return;
			if (event.key === 'Enter') {
				event.preventDefault();
				if (link?.files) {
					const first = shownFiles()[0];
					if (first) pick(fileAddress(first.key), first.name);
					return;
				}
				const hit = firstHit(linkHits(link?.query ?? '', editor.documents.get(), editor.site.collections));
				if (hit) pick(hit.href);
			} else if (event.key === 'Escape' || isLinkKey(event)) {
				// Claimed, so page-edit's Esc (leave the field, go up a level) skips it.
				event.preventDefault();
				pageEdit.claimKey(event);
				closeLink(true);
			}
		});
		// Focus going anywhere but the popover (the text, out of the frame) closes it.
		pop.addEventListener('focusout', (event) => {
			const to = event.relatedTarget as Node | null;
			if (choosing) return;
			if (!to || !pop.contains(to)) closeLink(false);
		});
		s.pop = pop;
		s.input = input;
		s.wrap.appendChild(pop);
		drawLinkBody();
		update();
		input.focus({ preventScroll: true });
		input.setSelectionRange(input.value.length, input.value.length);
	}

	/** The library's files the popover lists: found by name, as typed in the search. */
	function shownFiles() {
		const q = (shown?.input?.value ?? '').trim().toLowerCase();
		return (media.files.get().list ?? []).filter((f) => !q || f.name.toLowerCase().includes(q));
	}

	async function uploadFromPopover(file: File) {
		const tag = `rt-page-file-${Date.now()}`;
		uploading = { tag, name: file.name };
		uploadError = null;
		drawLinkBody();
		const sent = await media.uploadFile(file, tag);
		uploading = null;
		if (sent.ok) pick(fileAddress(sent.file.key), sent.file.name);
		else {
			uploadError = sent.error || null;
			drawLinkBody();
		}
	}

	/** M6c G4: the popover's body for files (File…), or for a link to a file. Null: the pages' body. */
	function fileBody(): string | null {
		if (!link) return null;
		const tile = '<span class="cms-ftype" aria-hidden="true"></span>';
		if (link.files) {
			const all = media.files.get();
			const list = shownFiles();
			const q = (shown?.input?.value ?? '').trim();
			let rows = `<div class="sw-h">Files</div>`;
			const up = uploading ? media.uploads.get().find((u) => u.id === uploading!.tag) : null;
			if (uploading) rows += `<div class="drow" role="status">${tile}<span class="nm">${esc(uploading.name)}</span><span class="meta">Uploading · ${up?.pct ?? 0}%</span></div>`;
			if (uploadError) rows += `<p class="cms-msg" role="status">${icon('warn')}<span>${esc(uploadError)}</span></p>`;
			if (all.unset) rows += `<div class="sw-more">${esc(all.unset.error)}</div>`;
			rows += list
				.slice(0, 8)
				.map((f, i) => `<button type="button" class="drow${i === 0 && q ? ' is-active' : ''}" data-file="${esc(f.key)}">${tile}<span class="nm">${esc(f.name)}</span><span class="meta">${esc(f.type)}${f.bytes !== null ? ` · ${esc(fileSize(f.bytes))}` : ''}</span></button>`)
				.join('');
			if (list.length > 8) rows += `<div class="sw-more">${list.length - 8} more: keep typing</div>`;
			if (all.list && list.length === 0) rows += `<div class="sw-more">${q ? `No file called “${esc(q)}”.` : 'No files yet.'}</div>`;
			rows += `<button type="button" class="drow" data-upload="">${icon('upload')}<span class="nm">Upload a file…</span></button><button type="button" class="drow" data-pages="">${icon('chev-l')}<span class="nm">Back to pages</span></button>`;
			return `<div class="cms-lpop-list">${rows}</div>`;
		}
		const file = link.editing ? fileKeyOf(link.query.trim()) : null;
		if (!file) return null;
		const entry = media.files.get().list?.find((f) => f.key === file.key);
		const missing = !!media.files.get().list && !entry;
		const type = fileTypeOf(file.key)!;
		const name = entry?.name ?? file.key.slice(file.key.lastIndexOf('/') + 1);
		const facts = missing ? "isn't in the library" : `${type.label}${entry?.bytes != null ? ` · ${fileSize(entry.bytes)}` : ''}`;
		let html = `<div class="cms-picked" data-picked-file="${esc(file.key)}">${missing ? icon('warn') : tile}<span class="ft"><b>${esc(name)}</b><small>${esc(facts)}</small></span><button type="button" class="cms-ib" data-remove="" aria-label="Remove the link">${icon('x')}</button></div>`;
		if (type.opensInTab && !missing) {
			html += `<div class="cms-opens"><span class="lbl">When clicked</span><span class="cms-seg" role="radiogroup" aria-label="When clicked"><button type="button" role="radio" aria-checked="${!file.download}" data-opens="tab">${icon('ext')}New tab</button><button type="button" role="radio" aria-checked="${file.download}" data-opens="download">${icon('download')}Download</button></span></div>`;
		}
		const foot = missing
			? 'This link goes nowhere until it points at a file in the library.'
			: !type.opensInTab
				? `A ${esc(type.label)} file doesn’t open in the browser: on the site, clicking it saves the file.`
				: null;
		return foot ? `${html}<div class="cms-lpop-foot">${foot}</div>` : html;
	}

	function drawLinkBody() {
		const s = shown;
		if (!s?.pop || !link) return;
		const files = fileBody();
		if (files !== null) {
			s.pop.querySelector('.cms-lpop-body')!.innerHTML = files;
			s.input!.placeholder = link.files ? 'Find a file' : 'Find a page, or type an address';
			s.input!.setAttribute('aria-label', s.input!.placeholder);
			return;
		}
		s.input!.placeholder = 'Find a page, or type an address';
		s.input!.setAttribute('aria-label', s.input!.placeholder);
		const hits = linkHits(link.query, editor.documents.get(), editor.site.collections);
		const { address, groups } = hits;
		const rule = address ? validateLink(address.href) : undefined;
		const collections = editor.site.collections;
		const docIconOf = (doc: ListedDocument | null) => docIcon(collections.find((c) => c.name === doc?.collection));
		const row = (h: LinkHit, active: boolean) =>
			`<button type="button" class="drow${active ? ' is-active' : ''}" data-href="${esc(h.href)}">${icon(docIconOf(h.doc))}<span class="nm">${h.crumb ? `<span class="crumb">${esc(h.crumb)} / </span>` : ''}${esc(h.doc?.label || h.doc?.title || '')}</span><span class="meta"><span class="mono">${esc(h.href)}</span></span></button>`;
		let list = '';
		if (address) {
			const kind = address.href.startsWith('mailto:') ? 'mail' : address.href.startsWith('/') ? 'page' : 'ext';
			list += `<button type="button" class="drow is-active" data-href="${esc(address.href)}">${icon(kind)}<span class="nm">Link to <span class="mono">${esc(address.href)}</span></span></button>`;
		}
		for (const g of groups) {
			list += `<div class="sw-h">${esc(g.label)}</div>`;
			list += g.hits.map((h) => row(h, !address && h === groups[0]!.hits[0])).join('');
			if (g.more > 0) list += `<div class="sw-more">${g.more} more: keep typing</div>`;
		}
		if (!address && groups.length === 0) list += `<div class="sw-more">No page called “${esc(link.query.trim())}”.</div>`;
		if (link.editing) list += `<button type="button" class="drow" data-remove="">${icon('x')}<span class="nm">Remove link</span></button>`;
		const msg = rule ? `<p class="cms-msg" id="cms-rt-msg" role="status">${icon('warn')}<span>${esc(rule)}</span></p>` : '';
		const body = s.pop.querySelector('.cms-lpop-body')!;
		body.innerHTML = `${msg}<div class="cms-lpop-list">${list}</div><div class="cms-lpop-foot">Or type an address.</div>`;
		if (rule) {
			s.input!.setAttribute('aria-invalid', 'true');
			s.input!.setAttribute('aria-describedby', 'cms-rt-msg');
		} else {
			s.input!.removeAttribute('aria-invalid');
			s.input!.removeAttribute('aria-describedby');
		}
	}

	/** Close the popover; `back`: focus returns to the text, with its selection (ProseMirror puts it back). */
	function closeLink(back: boolean) {
		const s = shown;
		if (!link && !s?.pop) return;
		link = null;
		if (!s) return;
		const pop = s.pop;
		s.pop = null;
		s.input = null;
		// Focus moves to the text before the search goes: taking out a focused node blurs it out of the frame.
		// (The popover's focusout then finds it already closed.)
		if (back && !s.state.editor.isDestroyed) s.state.view.focus();
		pop?.remove();
		update();
	}

	/** A row picked: the selection becomes the link; with none, the document's title (a file's name) is the link's text (as the sidebar does). */
	function pick(href: string, words?: string) {
		const s = shown;
		if (!s) return;
		const ed = s.state.editor;
		closeLink(true);
		if (ed.isDestroyed) return;
		if (ed.state.selection.empty && !ed.isActive('link')) {
			const doc = documentAt(href, linkable());
			const text = words ?? (doc ? doc.label || doc.title : href);
			const from = ed.state.selection.from;
			ed.chain().insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }).run();
			// The new words stay selected, so a file's popover (below) is over them.
			if (fileKeyOf(href)) ed.commands.setTextSelection({ from, to: from + text.length });
		} else {
			ed.chain().extendMarkRange('link').setMark('link', { href }).run();
		}
		// M6c G4: a link to a file opens again on the file, for New tab / Download.
		if (fileKeyOf(href)) openLink();
	}

	// ---- The bar's buttons ----

	function act(button: HTMLButtonElement) {
		const s = shown!;
		const ed = s.state.editor;
		if (ed.isDestroyed) return;
		// M6c G4: File…, a file picked, New tab / Download, Upload…, back to pages.
		if (button.hasAttribute('data-files') && link) {
			link = { ...link, files: true };
			if (media.files.get().list === null && !media.files.get().unset) void media.loadImages();
			s.input!.value = '';
			drawLinkBody();
			s.input!.focus({ preventScroll: true });
			return;
		}
		if (button.dataset.file !== undefined) {
			const file = media.files.get().list?.find((f) => f.key === button.dataset.file);
			if (file) pick(fileAddress(file.key), file.name);
			return;
		}
		if (button.dataset.opens !== undefined && link) {
			const file = fileKeyOf(link.query.trim());
			if (!file) return;
			const hash = link.query.indexOf('#');
			pick(`${fileAddress(file.key, { download: button.dataset.opens === 'download' })}${hash === -1 ? '' : link.query.slice(hash)}`);
			return;
		}
		if (button.hasAttribute('data-upload')) {
			choosing = true;
			s.win.addEventListener('focus', () => setTimeout(() => (choosing = false), 400), { once: true });
			s.wrap.querySelector<HTMLInputElement>('input[data-rt-file]')?.click();
			return;
		}
		if (button.hasAttribute('data-pages') && link) {
			link = { query: '', editing: link.editing };
			s.input!.value = '';
			drawLinkBody();
			s.input!.focus({ preventScroll: true });
			return;
		}
		if (button.hasAttribute('data-remove')) {
			closeLink(true);
			ed.chain().extendMarkRange('link').unsetMark('link').run();
			return;
		}
		if (button.classList.contains('drow')) {
			if (button.dataset.href !== undefined) pick(button.dataset.href);
			return;
		}
		const cmd = button.dataset.rtc;
		if (cmd === 'link') {
			if (link) closeLink(true);
			else openLink();
			return;
		}
		// Anything else from the bar goes back to the text first.
		if (link) closeLink(true);
		if (cmd === 'style') {
			menu = !menu;
			update();
			return;
		}
		menu = false;
		if (cmd === 'set') setBlockStyle(ed, button.dataset.v as BlockStyle);
		else if (cmd === 'bold' || cmd === 'italic') ed.chain().toggleMark(cmd).run();
		else if (cmd === 'ul' || cmd === 'ol') toggleList(ed, cmd === 'ul' ? 'bulletList' : 'orderedList');
		update();
	}

	// ---- Placement ----

	const kOf = (s: Shown) => {
		const scale = editor.stageLayout.get()?.[s.state.width].scale ?? 1;
		return 1 / (scale > 0 ? scale : 1);
	};

	/** The top-level block the caret is in (a paragraph, a heading, a whole list), and its index. */
	function caretBlock(s: Shown): { el: Element; index: number } | null {
		const { view } = s.state;
		const { doc, selection } = view.state;
		if (doc.childCount === 0) return null;
		const $head = selection.$head;
		const index = Math.min($head.index(0), doc.childCount - 1);
		const node = view.nodeDOM($head.posAtIndex(index, 0));
		const el = node && node.nodeType === 1 ? (node as Element) : (view.dom.children[index] ?? null);
		return el ? { el, index } : null;
	}

	function place(s: Shown) {
		const block = caretBlock(s);
		if (!block) return;
		const { win, doc, wrap, bar } = s;
		const k = kOf(s);
		const edge = EDGE * k;
		const gap = GAP * k;
		const vw = doc.documentElement.clientWidth;
		const vh = win.innerHeight;
		const bh = bar.offsetHeight;
		const bw = bar.offsetWidth;
		const bb = block.el.getBoundingClientRect();
		const sx = win.scrollX;
		const sy = win.scrollY;
		let p = s.placed;
		// It moves only when the caret changes block (or, by the caret's line, as the caret moves),
		// and when the block has grown under it.
		const covers = p && p.mode !== 'line' && p.top - sy < bb.bottom && p.top - sy + bh > bb.top;
		if (!p || p.block !== block.el || p.mode === 'line' || covers) {
			let above = bb.top - gap - bh >= edge;
			let top = above ? bb.top - gap - bh : bb.bottom + gap;
			let mode: 'above' | 'below' | 'line' = above ? 'above' : 'below';
			// A block taller than the frame: by the caret's own line instead.
			if (!above && top + bh > vh - edge) {
				const head = s.state.view.state.selection.head;
				const line = s.state.view.coordsAtPos(head);
				above = line.top - gap - bh >= edge;
				top = above ? line.top - gap - bh : line.bottom + gap;
				mode = 'line';
			}
			const left = Math.max(edge, Math.min(s.state.view.dom.getBoundingClientRect().left, vw - bw - edge));
			p = { block: block.el, index: block.index, mode, above, left: left + sx, top: top + sy };
			s.placed = p;
			wrap.style.left = `${p.left}px`;
			wrap.style.top = `${p.top}px`;
			wrap.dataset.place = above ? 'above' : 'below';
			wrap.dataset.block = String(block.index);
			if (mode === 'line') wrap.dataset.line = '';
			else delete wrap.dataset.line;
		}
		// The menu and the popover: on the bar's side away from the text, or past the block if there's no room.
		const topV = p.top - sy;
		const leftV = p.left - sx;
		const g = MENU_GAP * k;
		for (const f of [s.menu, s.pop]) {
			if (!f) continue;
			if (f === s.pop) f.style.width = `${Math.min(POPOVER_WIDTH * k, vw - 2 * edge)}px`;
			const fh = f.offsetHeight;
			const fw = f.offsetWidth;
			let ft = p.above ? topV - g - fh : topV + bh + g;
			if (p.above && ft < edge) ft = bb.bottom + gap;
			else if (!p.above && ft + fh > vh - edge && bb.top - gap - fh >= edge) ft = bb.top - gap - fh;
			f.style.top = `${ft - topV}px`;
			f.style.left = `${Math.max(edge, Math.min(leftV, vw - fw - edge)) - leftV}px`;
		}
	}

	/** The linked words' wash while the popover is open (ProseMirror's selection doesn't paint then). */
	function drawHolds(s: Shown) {
		const { view } = s.state;
		const { from, to, empty } = view.state.selection;
		if (!s.pop || empty) {
			if (s.holds.firstChild) s.holds.replaceChildren();
			return;
		}
		const a = view.domAtPos(from);
		const b = view.domAtPos(to);
		const range = s.doc.createRange();
		range.setStart(a.node, a.offset);
		range.setEnd(b.node, b.offset);
		const sx = s.win.scrollX;
		const sy = s.win.scrollY;
		const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
		s.holds.replaceChildren(
			...rects.map((r) => {
				const hold = s.doc.createElement('div');
				hold.className = 'cms-hold';
				hold.setAttribute('style', `left:${r.left + sx}px;top:${r.top + sy}px;width:${r.width}px;height:${r.height}px`);
				return hold;
			}),
		);
	}

	// ---- Following the page editor ----

	const follow = (state: PageEditorState | null) => {
		const visible = !!state && state.session && state.width === editor.view.get().width && !editor.access.get().readOnly;
		if (!visible) {
			hide();
			return;
		}
		if (shown && shown.state.editor === state.editor && shown.state.frame === state.frame) {
			shown.state = state;
			update();
			return;
		}
		hide();
		show(state);
	};

	const stops = [
		pageEdit.pageEditor.subscribe((state) => follow(state)),
		editor.access.subscribe(() => follow(pageEdit.pageEditor.get())),
		editor.stageLayout.subscribe(() => {
			if (!shown) return;
			shown.placed = null;
			update();
		}),
		// ⌘K is the link on the page (never the document switcher); Esc closes the menu or popover first.
		pageEdit.onEditorKey((event) => {
			if (!shown) return false;
			if (isLinkKey(event)) {
				if (link) closeLink(true);
				else openLink();
				return true;
			}
			if (event.key === 'Escape' && (menu || link)) {
				menu = false;
				if (link) closeLink(true);
				else update();
				return true;
			}
			return false;
		}),
	];
	follow(pageEdit.pageEditor.get());

	return () => {
		for (const stop of stops) stop();
		for (const stop of stopFiles) stop();
		hide();
	};
}
