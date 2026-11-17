/**
 * Edit in context, Decision 3: the Header and Footer pickers, in their own group above SEO on
 * every document with an address (a page, a held document, a fields document with an address,
 * hidden ones too), the mockup's #page-footer-pick.
 *
 * - **Only when the site has more than one** block for that slot; with one, there's nothing to
 *   pick. A page that still holds a pick (the site's down to one, or the pick's gone) keeps its
 *   picker, so the pick can be seen and cleared.
 * - **Left empty, the page gets the default:** the box says "Default: Footer".
 * - **A pick is kept as picked** (`frame.<slot>`, document-store.ts → setFrame), even of the
 *   current default, so the page keeps it when another becomes the default. Clearing it (×)
 *   takes the pick out.
 * - **A pick that isn't usable** (gone, of an unknown type, of the other slot) shows as missing,
 *   as a reference does, and the page gets the default (slots.ts).
 */
import { useState, type KeyboardEvent } from 'react';
import type { SlotName } from '../../../config.ts';
import { titleCase } from '../../../fields.ts';
import { useEditor, useStore } from '../context.tsx';
import { usedOnLine } from '../block-list/summary.ts';
import { pickableSlots, slotBlocks } from '../collections/shared-groups.ts';
import { Icon } from '../shell/Icons.tsx';
import { FieldFrame } from './FieldFrame.tsx';
import { FieldHostProvider, type FieldHost } from './host.tsx';
import type { ListedDocument } from '../../types.ts';

const SCOPE = 'frame';

export function FramePickers() {
	const editor = useEditor();
	const session = useStore(editor.doc.state);
	const documents = useStore(editor.documents);
	const readOnly = useStore(editor.access, (a) => a.readOnly);
	const [open, setOpen] = useState(true);
	const { document, ref, entry } = session;
	const collection = editor.site.collections.find((c) => c.name === ref.collection);
	if (document.kind !== 'sections' && document.kind !== 'fields') return null;
	if (!collection?.urlBase && entry.url === null) return null;
	const slots = pickableSlots(documents, document.frame);
	if (!slots.length) return null;
	const host: FieldHost = { scope: SCOPE, picked: () => null, pick() {}, set() {}, removeItem() {}, raw: () => undefined, readOnly };
	const summary = slots.map((slot) => pickedName(documents, slot, document.frame?.[slot])).join(' · ');
	return (
		<details className="fgroup frame-picks" open={open} data-frame-picks="" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
			<summary>
				{slots.length === 2 ? 'Header and footer' : titleCase(slots[0]!)} <span className="s">· {summary}</span>
				<Icon name="chev-r" size="sm" />
			</summary>
			<div className="in">
				<FieldHostProvider host={host}>
					{slots.map((slot) => (
						<SlotPicker key={slot} slot={slot} pick={document.frame?.[slot]} documents={documents} readOnly={readOnly} onPick={(path) => editor.doc.setFrame(slot, path)} />
					))}
				</FieldHostProvider>
			</div>
		</details>
	);
}

/** The summary's word for a slot: the pick's title, "Default (Footer)", or "Missing". */
function pickedName(documents: readonly ListedDocument[], slot: SlotName, pick: string | undefined): string {
	const blocks = slotBlocks(documents, slot);
	if (pick !== undefined) return blocks.find((d) => d.path === pick)?.label ?? 'Missing';
	const def = blocks.find((d) => d.default);
	return def ? `Default (${def.label})` : 'None';
}

function SlotPicker(props: { slot: SlotName; pick: string | undefined; documents: readonly ListedDocument[]; readOnly: boolean; onPick: (path: string | null) => void }) {
	const { slot, pick, documents, readOnly } = props;
	const [choosing, setChoosing] = useState(false);
	const blocks = slotBlocks(documents, slot);
	const def = blocks.find((d) => d.default);
	const picked = pick !== undefined ? blocks.find((d) => d.path === pick) : undefined;
	const missing = pick !== undefined && !picked;
	const label = titleCase(slot);
	const plural = `${slot}s`;
	const id = `f-${SCOPE}-${slot}`;
	const choose = (path: string | null) => {
		props.onPick(path);
		setChoosing(false);
	};
	const onKey = (event: KeyboardEvent) => {
		if (event.key === 'Escape' && choosing) {
			event.preventDefault();
			event.stopPropagation();
			setChoosing(false);
		}
	};
	return (
		<FieldFrame
			blockKey={SCOPE}
			name={slot}
			label={label}
			labelId={`${id}-l`}
			meta={`Shared · ${blocks.length} ${blocks.length === 1 ? slot : plural}`}
			help={`Left empty, this page gets the site's default ${slot}.`}
		>
			<div className={`lnk${missing ? ' is-missing' : ''}`} data-frame-pick={slot} onKeyDown={onKey}>
				<div className="lnk-box" data-path={slot}>
					<Icon name={missing ? 'warn' : 'shared'} size="sm" />
					{missing ? (
						<span className="lnk-doc two">
							<b>One that's gone</b>
							<span>{`${pick} · this page gets the default ${slot}`}</span>
						</span>
					) : picked ? (
						<span className="lnk-doc">
							<b>{picked.label}</b>
						</span>
					) : (
						<span className="ph-t">{def ? `Default: ${def.label}` : `No default ${slot}`}</span>
					)}
					{pick !== undefined ? (
						<button type="button" className="ib" aria-label={`Clear the ${slot} pick`} data-act="clear-frame" disabled={readOnly} onClick={() => choose(null)}>
							<Icon name="x" size="sm" />
						</button>
					) : null}
					<button
						type="button"
						className="ib"
						id={id}
						aria-label={`Choose a ${slot}`}
						aria-haspopup="listbox"
						aria-expanded={choosing}
						disabled={readOnly}
						onClick={() => setChoosing(!choosing)}
					>
						<Icon name="chev-d" size="sm" />
					</button>
				</div>
				{choosing ? (
					<div
						className="lpop"
						role="listbox"
						aria-label={titleCase(plural)}
						onBlur={(e) => {
							if (!e.currentTarget.closest('.lnk')?.contains(e.relatedTarget as Node | null)) setChoosing(false);
						}}
					>
						<p className="sw-h grp-h" style={{ position: 'static', height: 'auto' }}>
							{titleCase(plural)}
						</p>
						{blocks.map((d, i) => (
							<button
								key={d.path}
								type="button"
								role="option"
								aria-selected={d.path === pick}
								className={`drow${d.path === pick ? ' is-active' : ''}`}
								data-frame-option={d.path}
								autoFocus={i === 0}
								onClick={() => choose(d.path)}
							>
								<Icon name="shared" />
								<span className="nm">{d.label}</span>
								<span className="meta">
									{d.default ? (
										<span className="chip def" data-chip="default">
											Default
										</span>
									) : null}
									<span>{usedOnLine(d)}</span>
								</span>
							</button>
						))}
					</div>
				) : null}
			</div>
		</FieldFrame>
	);
}
