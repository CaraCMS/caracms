/**
 * Link (M5a Decision 4): `{ "label", "href" }`. The mockup's `.lnk`: where it goes
 * is a document picked from the site (shown by its title and address; the URL is
 * what's stored) or a typed `/path`, `https://…`, `mailto:`, `tel:` or `#anchor`.
 * Typing a name lists the site's documents; typing an address keeps it as typed.
 *
 * - A link that fails the link rule is kept as typed, with the rule's message
 *   (Decision 15); the page shows its label as text.
 * - A `/path` that matches no document says so ("Links to /contact, which no page
 *   or route serves"), never an error.
 * - Half a link (only a label, or only where it goes) says it shows nothing.
 * - M6c (G9): an address-only link (`addressOnly`) is where it goes alone: no Label box,
 *   never half a link; the rule, the picker and the missing-page warning as any link's.
 *
 * - M6c G4 (Decisions 5, 7, 10): **File…** beside the box opens the library on Files as a
 *   picker (`pick.link`), and the file's address is what's stored. A file link shows the
 *   file (its tile, name, type and size); a PDF gets "When clicked": New tab (the
 *   default) or Download (`?download` in the address); any other type says it downloads.
 *   A file link whose key isn't in the library gets the missing-target warning.
 *
 * `LinkControl` is the "where it goes" part alone, which buttons and lists use too.
 */
import { useEffect, useState } from 'react';
import type { FieldWarning, LinkField as LinkDescriptor, LinkValue } from '../../../fields.ts';
import { fileAddress, fileKeyOf, fileTypeOf } from '../../../files.ts';
import { internalLinkPath } from '../../../links.ts';
import { useEditor, useStore } from '../context.tsx';
import { docIcon } from '../nav/DocRow.tsx';
import { parentLabel } from '../nav/search.ts';
import { Icon } from '../shell/Icons.tsx';
import { FieldFrame } from './FieldFrame.tsx';
import { fileSize, mediaFor } from '../media/store.ts';
import { FileTile } from '../pane/levels/MediaLevel.tsx';
import { useFieldWarnings, useHost, warningsAt } from './host.tsx';
import { ownerOf } from './MediaField.tsx';
import { documentAt, FieldIcon, LinkPopover, looksLikeAddress, useLinkable, Warnings } from './parts.tsx';

/** A file link's address with New tab or Download chosen, its fragment kept. */
export function withDownload(href: string, download: boolean): string {
	const file = fileKeyOf(href.trim());
	if (!file) return href;
	const hash = href.indexOf('#');
	return `${fileAddress(file.key, { download })}${hash === -1 ? '' : href.slice(hash)}`;
}

/** M6c G4: "When clicked": New tab or Download, for a link to a PDF (Decision 5). */
export function OpensToggle(props: { href: string; onChange: (href: string) => void; disabled?: boolean }) {
	const download = !!fileKeyOf(props.href.trim())?.download;
	return (
		<div className="opens">
			<span className="lbl">When clicked</span>
			<div className="mini-seg" role="radiogroup" aria-label="When clicked">
				<button type="button" role="radio" aria-checked={!download} data-opens="tab" disabled={props.disabled} onClick={() => props.onChange(withDownload(props.href, false))}>
					<Icon name="ext" />
					New tab
				</button>
				<button type="button" role="radio" aria-checked={download} data-opens="download" disabled={props.disabled} onClick={() => props.onChange(withDownload(props.href, true))}>
					<Icon name="download" />
					Download
				</button>
			</div>
		</div>
	);
}

/** The library's files, read once when a file link shows (last known meanwhile). */
export function useLibraryFiles() {
	const editor = useEditor();
	const media = mediaFor(editor);
	const files = useStore(media.files);
	useEffect(() => {
		if (media.files.get().list === null && !media.files.get().unset) void media.loadImages();
	}, [media]);
	return files;
}

/**
 * Where a link goes. `path` is the href's own path (`cta.href`, `buttons.1.href`),
 * `warnings` the ones about it (link rule, a document that doesn't exist).
 */
export function LinkControl(props: { path: string; href: string; onChange: (href: string) => void; warnings: readonly FieldWarning[]; label?: string }) {
	const editor = useEditor();
	const host = useHost();
	const documents = useStore(editor.documents);
	const linkable = useLinkable();
	const [query, setQuery] = useState<string | null>(null);
	const href = props.href;
	const file = fileKeyOf(href.trim());
	const doc = href && !file ? documentAt(href, linkable) : undefined;
	const missing = props.warnings.find((w) => w.code === 'link-missing');
	const hiddenTarget = props.warnings.find((w) => w.code === 'link-hidden');
	const rule = props.warnings.find((w) => w.code === 'link-rule');
	const files = useLibraryFiles();
	const chooseFile = () => {
		if (host.readOnly) return;
		const { owner, back } = ownerOf(editor, host.scope);
		editor.openMedia({ pick: { scope: host.scope, path: props.path, label: `${owner} · ${props.label ?? 'Link'}`, owner, multi: false, back, link: true } });
	};
	const fileButton = (
		<button type="button" className="btn" data-act="link-file" title="Link to a file in the library" disabled={host.readOnly} onClick={chooseFile}>
			<FieldIcon name="file" size="sm" />
			File…
		</button>
	);
	const focusInput = () => requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`input[data-path="${CSS.escape(props.path)}"]`)?.focus());
	const clear = (
		<button
			type="button"
			className="ib"
			aria-label="Change where it goes"
			onClick={() => {
				props.onChange('');
				focusInput();
			}}
		>
			<Icon name="x" size="sm" />
		</button>
	);

	if (file && !rule) {
		const entry = files.list?.find((f) => f.key === file.key);
		const name = entry?.name ?? file.key.slice(file.key.lastIndexOf('/') + 1);
		const type = fileTypeOf(file.key)!;
		if (missing) {
			return (
				<>
					<div className="lnk-row">
						<div className="lnk is-missing" data-link-path={props.path}>
							<div className="lnk-box" data-path={props.path} tabIndex={-1}>
								<Icon name="warn" />
								<span className="lnk-doc two">
									<b>{name}</b>
									<span>isn't in the library</span>
								</span>
								{clear}
							</div>
						</div>
						{fileButton}
					</div>
					<Warnings warnings={[missing]} />
				</>
			);
		}
		return (
			<>
				<div className="lnk" data-link-path={props.path} data-link-file={file.key}>
					<div className="lnk-box" data-path={props.path} tabIndex={-1}>
						<span className="lnk-file">
							<FileTile size="sm" />
							<span className="lnk-doc two">
								<b>{name}</b>
								<span className="mono">
									{type.label}
									{entry?.bytes != null ? ` · ${fileSize(entry.bytes)}` : ''}
								</span>
							</span>
						</span>
						{clear}
					</div>
				</div>
				{type.opensInTab ? (
					<>
						<OpensToggle href={href} onChange={props.onChange} disabled={host.readOnly} />
						<p className="field-hint">
							<FieldIcon name="link" size="xs" />
							<span className="mono" style={{ overflowWrap: 'anywhere' }}>
								{href.trim()}
							</span>
						</p>
					</>
				) : (
					<p className="dl-note">
						<Icon name="download" size="sm" />
						<span>
							<b>Downloads.</b> {/^[AEIOU]/.test(type.label) ? 'An' : 'A'} {type.label} file doesn’t open in the browser, so clicking it saves the file.
						</span>
					</p>
				)}
			</>
		);
	}
	if (doc && !rule) {
		const collection = editor.site.collections.find((c) => c.name === doc.collection);
		const crumb = collection?.nested ? parentLabel(doc, documents) : '';
		// M9 Decision 7: a link to a hidden page keeps its chip, with the warning under it.
		return (
			<>
				<div className="lnk" data-link-path={props.path} data-link-hidden={hiddenTarget ? '' : undefined}>
					<div className="lnk-box" data-path={props.path} tabIndex={-1}>
						<Icon name={docIcon(collection)} />
						<span className="lnk-doc">
							<b>
								{crumb ? `${crumb} / ` : ''}
								{doc.label || doc.title}
							</b>
							<span className="mono">{doc.url}</span>
						</span>
						{clear}
					</div>
				</div>
				{hiddenTarget ? <Warnings warnings={[hiddenTarget]} /> : null}
			</>
		);
	}
	if (missing && !rule) {
		return (
			<>
				<div className="lnk is-missing" data-link-path={props.path}>
					<div className="lnk-box" data-path={props.path} tabIndex={-1}>
						<Icon name="warn" />
						<span className="lnk-doc">
							<b>{internalLinkPath(href) ?? href}</b>
							<span>no page or route serves it</span>
						</span>
						{clear}
					</div>
				</div>
				<Warnings warnings={[missing]} />
			</>
		);
	}
	const kind = href.startsWith('mailto:') ? 'mail' : href.startsWith('tel:') ? 'phone' : href.startsWith('#') ? 'anchor' : href.startsWith('/') ? 'page' : href ? 'ext' : 'search';
	const open = query !== null && query.trim() !== '' && !looksLikeAddress(query);
	return (
		<>
			<div className="lnk-row">
				<div className={`lnk${rule && !open ? ' is-bad' : ''}`} data-link-path={props.path}>
					<div className="lnk-box">
						{kind === 'anchor' ? (
							<span className="lnk-glyph" aria-hidden="true">
								#
							</span>
						) : (
							<Icon name={kind} />
						)}
						<input
							value={href}
							placeholder="Find a page, or type an address"
							aria-label={props.label ?? 'Where it goes'}
							data-path={props.path}
							autoComplete="off"
							spellCheck={false}
							aria-invalid={rule && !open ? true : undefined}
							onChange={(e) => {
								setQuery(e.target.value);
								props.onChange(e.target.value);
							}}
							onBlur={() => setQuery(null)}
							onKeyDown={(e) => {
								if (e.key === 'Escape' && open) {
									e.preventDefault();
									setQuery(null);
								}
							}}
						/>
					</div>
					{open ? (
						<LinkPopover
							query={query}
							onPick={(next) => {
								props.onChange(next);
								setQuery(null);
							}}
							onClose={() => setQuery(null)}
						/>
					) : null}
				</div>
				{fileButton}
			</div>
			{rule && !open ? <Warnings warnings={[rule]} /> : null}
		</>
	);
}

export function LinkField(props: { name: string; label: string; field: LinkDescriptor; value: unknown }) {
	const host = useHost();
	const id = `f-${host.scope}-${props.name}`;
	const value = (props.value && typeof props.value === 'object' ? props.value : { label: '', href: '' }) as LinkValue;
	const warnings = useFieldWarnings(props.name, props.field, props.value);
	if (props.field.addressOnly) {
		return (
			<FieldFrame blockKey={host.scope} name={props.name} label={props.label} help={props.field.help} labelId={`${id}-l`}>
				<LinkControl path={`${props.name}.href`} href={value.href ?? ''} label={props.label} warnings={warningsAt(warnings, 'href')} onChange={(href) => host.set(`${props.name}.href`, href)} />
				<Warnings warnings={warnings.filter((w) => w.code === 'unreadable')} />
			</FieldFrame>
		);
	}
	return (
		<FieldFrame blockKey={host.scope} name={props.name} label={props.label} help={props.field.help} labelId={`${id}-l`}>
			<label className="sub-label" htmlFor={`${id}-label`}>
				Label
			</label>
			<input
				className="input"
				id={`${id}-label`}
				data-path={`${props.name}.label`}
				value={value.label}
				autoComplete="off"
				spellCheck={false}
				onChange={(e) => host.set(`${props.name}.label`, e.target.value.replace(/\n+/g, ' '))}
			/>
			<span className="sub-label">Link</span>
			<LinkControl path={`${props.name}.href`} href={value.href} warnings={warningsAt(warnings, 'href')} onChange={(href) => host.set(`${props.name}.href`, href)} />
			<Warnings warnings={warnings.filter((w) => w.code === 'half-link' || w.code === 'unreadable')} />
		</FieldFrame>
	);
}
